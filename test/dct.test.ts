import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK, T, dct2d, idct2d } from "../src/core/dct.js";
import { toZigzag, fromZigzag } from "../src/core/zigzag.js";
import { decodeBlock, encodeBlock } from "../src/core/rle.js";
import { allFixtures } from "../src/core/fixtures.js";

test("DCT matrix is orthonormal: T * T^T = I", () => {
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let sum = 0;
      for (let k = 0; k < 8; k++) sum += T[i]![k]! * T[j]![k]!;
      assert.ok(Math.abs(sum - (i === j ? 1 : 0)) < 1e-12);
    }
  }
});

test("lossless transform round trip without quantization on all fixtures", () => {
  for (const img of Object.values(allFixtures())) {
    const block: number[][] = Array.from({ length: 8 }, (_, y) =>
      Array.from({ length: 8 }, (_, x) => img.pixels[y * img.width + x]! - 128),
    );
    const back = idct2d(dct2d(block));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) assert.ok(Math.abs(back[y]![x]! - block[y]![x]!) < 1e-9);
    }
  }
});

test("Parseval energy relation: spatial energy equals spectral energy", () => {
  const block = Array.from({ length: BLOCK }, (_, y) =>
    Array.from({ length: BLOCK }, (_, x) => (x * 7 + y * 13) % 200 - 100),
  );
  const spatial = block.flat().reduce((s, v) => s + v * v, 0);
  const spectral = dct2d(block).flat().reduce((s, v) => s + v * v, 0);
  assert.ok(Math.abs(spatial - spectral) / spatial < 1e-10);
});

test("DC coefficient equals mean times sqrt(64)", () => {
  const block = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 42));
  const coeffs = dct2d(block);
  assert.ok(Math.abs(coeffs[0]![0]! - 42 * 8) < 1e-9);
  let acEnergy = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (x || y) acEnergy += coeffs[y]![x]! ** 2;
  assert.ok(acEnergy < 1e-18);
});

test("zigzag is invertible and starts at DC", () => {
  const block = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => y * 8 + x));
  const zig = toZigzag(block);
  assert.equal(zig[0], 0);
  assert.deepEqual(fromZigzag(zig), block);
});

test("RLE round trip preserves coefficients and drops trailing zeros", () => {
  const zig = [120, 0, 0, -3, 0, 5, ...new Array<number>(58).fill(0)];
  const { tokens } = encodeBlock(zig);
  assert.deepEqual(tokens, [
    { run: 0, value: 120 },
    { run: 2, value: -3 },
    { run: 1, value: 5 },
  ]);
  assert.deepEqual(decodeBlock(tokens), zig);
});

test("RLE rejects illegal runs and zero values", () => {
  assert.throws(() => decodeBlock([{ run: 64, value: 1 }]), (e: { code?: string }) => e.code === "INVALID_RUN");
  assert.throws(() => decodeBlock([{ run: 63, value: 1 }, { run: 1, value: 2 }]), (e: { code?: string }) => e.code === "INVALID_RUN");
  assert.throws(() => decodeBlock([{ run: 0, value: 0 }]), (e: { code?: string }) => e.code === "INVALID_COEFFICIENT");
});

test("all-zero block encodes to zero tokens and decodes back to zeros", () => {
  const { tokens } = encodeBlock(new Array<number>(64).fill(0));
  assert.deepEqual(tokens, []);
  assert.deepEqual(decodeBlock([]), new Array<number>(64).fill(0));
});
