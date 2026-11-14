"use strict";
// Tastemaker's own pure-JavaScript replacement for the npm package `bigint-buffer`.
// No native addon, no dependencies, no install scripts. See README.md for why it exists.

// Upper bound, in bytes, for the `width` argument and for the length of a decoded buffer.
// Far above any real use (u64/u256 layouts); it keeps the work per call linear and bounded.
const MAX_WIDTH = 1 << 20;

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? "0" : "") + i.toString(16));

const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
).get;

function checkBytes(buf) {
  // Not `instanceof`: a Buffer or Uint8Array from another realm (vm, jsdom) must work too.
  // The %TypedArray% tag getter cannot be spoofed and returns undefined for non-typed-arrays.
  if (typedArrayTag.call(buf) !== "Uint8Array") {
    throw new TypeError("bigint-buffer: expected a Buffer or Uint8Array");
  }
  if (buf.length > MAX_WIDTH) {
    throw new RangeError("bigint-buffer: buffer too long");
  }
}

function checkNumber(num) {
  if (typeof num !== "bigint") {
    throw new TypeError("bigint-buffer: expected a bigint value");
  }
  if (num < 0n) {
    throw new RangeError("bigint-buffer: value must not be negative");
  }
}

function checkWidth(width) {
  if (typeof width !== "number" || !Number.isInteger(width)) {
    throw new TypeError("bigint-buffer: width must be an integer");
  }
  if (width < 0 || width > MAX_WIDTH) {
    throw new RangeError("bigint-buffer: width out of range");
  }
}

function alloc(width) {
  // A Buffer where one exists (Node, or a bundler's Buffer shim), a plain Uint8Array otherwise.
  return typeof Buffer === "function" && typeof Buffer.alloc === "function"
    ? Buffer.alloc(width)
    : new Uint8Array(width);
}

// Hex of the bytes, most significant first. Linear in the length.
function toBigInt(buf, littleEndian) {
  checkBytes(buf);
  const n = buf.length;
  if (n === 0) return 0n;
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = HEX[buf[littleEndian ? n - 1 - i : i]];
  return BigInt("0x" + parts.join(""));
}

// Bytes of `num`, most significant first, `width` of them. Linear in `width`.
function toBytes(num, width, littleEndian) {
  checkNumber(num);
  checkWidth(width);
  // One linear shift, before any allocation or loop: refuses a value that needs more than `width` bytes.
  if (num >= 1n << BigInt(8 * width)) {
    throw new RangeError("bigint-buffer: value does not fit in width");
  }
  const out = alloc(width);
  if (width === 0) return out;
  const hex = num.toString(16).padStart(2 * width, "0");
  for (let i = 0; i < width; i++) {
    out[littleEndian ? width - 1 - i : i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const toBigIntBE = (buf) => toBigInt(buf, false);
const toBigIntLE = (buf) => toBigInt(buf, true);
const toBufferBE = (num, width) => toBytes(num, width, false);
const toBufferLE = (num, width) => toBytes(num, width, true);

module.exports = { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE };
