"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE } = require("../index.js");

// Expected values come from plain BigInt arithmetic, never from the old native addon.
const bytesLE = (n, width) => {
  const out = [];
  for (let i = 0; i < width; i++) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
};
const bytesBE = (n, width) => bytesLE(n, width).reverse();
const max = (w) => (1n << BigInt(8 * w)) - 1n;
const values = (w) => [0n, 1n, 0xffn, 0x0102030405060708n & max(w), max(w) - 1n, max(w), 1n << BigInt(8 * w - 1)];

test("decodes known byte strings", () => {
  assert.equal(toBigIntLE(Buffer.from([0x01, 0x02])), 0x0201n);
  assert.equal(toBigIntBE(Buffer.from([0x01, 0x02])), 0x0102n);
  assert.equal(toBigIntLE(Uint8Array.from([0xff])), 255n);
  assert.equal(toBigIntBE(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1])), 1n);
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntBE(Buffer.alloc(0)), 0n);
});

test("encodes known values", () => {
  assert.deepEqual([...toBufferLE(0x0201n, 2)], [0x01, 0x02]);
  assert.deepEqual([...toBufferBE(0x0201n, 2)], [0x02, 0x01]);
  assert.deepEqual([...toBufferLE(1n, 8)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...toBufferBE(1n, 8)], [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...toBufferLE(7n, 4)], [7, 0, 0, 0]);
  assert.deepEqual([...toBufferBE(7n, 4)], [0, 0, 0, 7]);
  assert.equal(toBufferLE(0n, 0).length, 0);
  assert.equal(toBufferBE(0n, 0).length, 0);
});

test("returns a Buffer in Node", () => {
  assert.ok(Buffer.isBuffer(toBufferLE(5n, 4)));
  assert.ok(Buffer.isBuffer(toBufferBE(5n, 4)));
});

for (const w of [1, 8, 16, 32]) {
  test(`matches BigInt arithmetic at ${w} bytes, both endians, with round trips`, () => {
    for (const v of values(w)) {
      const le = toBufferLE(v, w);
      const be = toBufferBE(v, w);
      assert.equal(le.length, w);
      assert.equal(be.length, w);
      assert.deepEqual([...le], bytesLE(v, w));
      assert.deepEqual([...be], bytesBE(v, w));
      assert.equal(toBigIntLE(le), v);
      assert.equal(toBigIntBE(be), v);
      assert.equal(toBigIntLE(Uint8Array.from(bytesLE(v, w))), v);
      assert.equal(toBigIntBE(Uint8Array.from(bytesBE(v, w))), v);
    }
  });
}

test("rejects non-byte input to the decoders with a TypeError", () => {
  for (const b of [undefined, null, "01", 5, [1, 2], { length: 2 }, new ArrayBuffer(2), new Uint16Array(2), new DataView(new ArrayBuffer(2))]) {
    assert.throws(() => toBigIntLE(b), TypeError);
    assert.throws(() => toBigIntBE(b), TypeError);
  }
  const spoof = new Uint16Array(2);
  Object.defineProperty(spoof, Symbol.toStringTag, { value: "Uint8Array" });
  assert.throws(() => toBigIntLE(spoof), TypeError);
});

test("rejects non-bigint values with a TypeError", () => {
  for (const v of [1, "1", null, undefined, 1.5]) {
    assert.throws(() => toBufferLE(v, 4), TypeError);
    assert.throws(() => toBufferBE(v, 4), TypeError);
  }
});

test("rejects a bad width", () => {
  for (const w of [-1, 1.5, NaN, Infinity, (1 << 20) + 1, 2 ** 40, "4", undefined, null]) {
    assert.throws(() => toBufferLE(1n, w), /width/);
    assert.throws(() => toBufferBE(1n, w), /width/);
  }
  assert.throws(() => toBufferLE(1n, -1), RangeError);
  assert.throws(() => toBufferBE(1n, 2 ** 40), RangeError);
  assert.throws(() => toBufferLE(1n, 1.5), TypeError);
});

test("accepts the largest allowed width", () => {
  assert.equal(toBufferLE(1n, 1 << 20).length, 1 << 20);
});

test("rejects a negative value and a value that does not fit", () => {
  assert.throws(() => toBufferLE(-1n, 8), RangeError);
  assert.throws(() => toBufferBE(-1n, 8), RangeError);
  assert.throws(() => toBufferLE(256n, 1), RangeError);
  assert.throws(() => toBufferBE(max(8) + 1n, 8), RangeError);
  assert.throws(() => toBufferLE(1n, 0), RangeError);
});

test("stays fast on large inputs (linear work, bounded sizes)", () => {
  const t = Date.now();
  const big = Buffer.alloc(1 << 20, 0xab);
  const expected = BigInt("0x" + "ab".repeat(1 << 20));
  assert.equal(toBigIntBE(big), expected);
  assert.equal(toBigIntLE(big), expected);
  assert.throws(() => toBigIntLE(Buffer.alloc((1 << 20) + 1)), RangeError);
  const huge = (1n << 9_000_000n) - 1n; // more than 1 MiB
  assert.throws(() => toBufferLE(huge, 0), RangeError);
  assert.throws(() => toBufferBE(huge, 1 << 20), RangeError);
  assert.throws(() => toBufferLE(huge, 1 << 20), RangeError);
  assert.ok(Date.now() - t < 2500);
});

test("accepts a Uint8Array from another realm", () => {
  const foreign = vm.runInNewContext("new Uint8Array([1, 2])");
  assert.equal(foreign instanceof Uint8Array, false);
  assert.equal(toBigIntLE(foreign), 0x0201n);
  assert.equal(toBigIntBE(foreign), 0x0102n);
});

test("does not change its input", () => {
  const b = Buffer.from([1, 2, 3]);
  toBigIntLE(b);
  toBigIntBE(b);
  assert.deepEqual([...b], [1, 2, 3]);
});
