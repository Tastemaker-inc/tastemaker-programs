# bigint-buffer (Tastemaker's own copy)

Pure-JavaScript conversion between `bigint` and byte buffers. No native addon, no dependencies, no install scripts.

In tastemaker-web this folder replaces the npm package `bigint-buffer` 1.1.5 everywhere in the dependency tree
(`dependencies` plus `overrides` in the app's `package.json`). That package's native `toBigIntLE` has a known crash
(GHSA-3gc7-fjrx-p6mg) with no upstream fix.

## API

- `toBigIntLE(buf)`, `toBigIntBE(buf)`: bytes to a non-negative `bigint` (empty input gives `0n`).
- `toBufferLE(num, width)`, `toBufferBE(num, width)`: a `bigint` to exactly `width` bytes (a `Buffer` where `Buffer` exists, else a `Uint8Array`).

Input checks: a non-`Uint8Array` input, a non-`bigint` value or a non-integer width is a `TypeError`.
A negative value, a width outside 0 to 1048576, a buffer longer than 1048576 bytes, or a value that does not fit in `width` bytes is a `RangeError`.
(The original cut a too-large value silently.) Inputs are never modified.

## Tests

Standalone, no dependency on the app: `node --test` (or `npm test`) in this folder, Node 18 or newer.

## Provenance

An independent implementation of the documented API of the npm package; not compared line by line against it.

## Status

`private: true`, name and license are not decided: see `LICENSE` (owner to choose). Nothing here is published.
