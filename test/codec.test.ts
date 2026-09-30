import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, readBlockCoefficients } from "../src/core/codec.js";
import { uniformSteps, scaledSteps, quantizeCoefficient } from "../src/core/quantize.js";
import { computeError } from "../src/core/metrics.js";
import { allFixtures } from "../src/core/fixtures.js";
import { HEADER_LENGTH, MAGIC, parseContainer, serializeContainer } from "../src/core/container.js";
import { CodecError } from "../src/core/errors.js";

test("fine sub-integer steps give pixel-perfect round trip on non-multiple sizes", () => {
  for (const name of ["constant", "constantOdd", "gradient", "impulse"]) {
    const img = allFixtures()[name]!;
    const blob = compress(img, uniformSteps(0.25), "reflect").blob;
    const decoded = decompress(blob);
    assert.equal(decoded.width, img.width, name);
    assert.equal(decoded.height, img.height, name);
    assert.deepEqual(decoded.pixels, img.pixels, name);
    const report = computeError(img, decoded, "a");
    assert.equal(report.mse, 0);
    assert.equal(report.psnrState, "infinite");
    assert.equal(report.psnrDb, null);
  }
});

test("padding rows/columns are cropped: decoded size equals stored original size", () => {
  const img = allFixtures().checker!; // 19x11
  assert.equal(img.width % 8 !== 0 || img.height % 8 !== 0, true);
  for (const padding of ["zero", "edge", "reflect"] as const) {
    const decoded = decompress(compress(img, uniformSteps(0.25), padding).blob);
    assert.equal(decoded.pixels.length, img.width * img.height);
  }
});

test("quantization rounding is symmetric on negatives (half away from zero)", () => {
  assert.equal(quantizeCoefficient(3 * 2 + 1, 2), 4);
  assert.equal(quantizeCoefficient(-(3 * 2 + 1), 2), -4);
  assert.equal(quantizeCoefficient(1, 2), 1);
  assert.equal(quantizeCoefficient(-1, 2), -1);
});

test("byteLength is actual serialized size, not nonzero count, and shrinks for constant", () => {
  const random = allFixtures().random!;
  const constant = allFixtures().constant!;
  const r = compress(random, scaledSteps(30), "reflect");
  const c = compress(constant, scaledSteps(30), "reflect");
  assert.equal(r.byteLength, r.blob.length);
  assert.equal(c.byteLength, c.blob.length);
  assert.ok(c.byteLength < r.byteLength);
  assert.ok(r.blob.subarray(0, 4).equals(MAGIC));
  assert.ok(r.byteLength >= HEADER_LENGTH);
});

test("container stores quant table, padding and version; coefficients readable from bytes alone", () => {
  const img = allFixtures().gradient!;
  const steps = scaledSteps(40);
  const result = compress(img, steps, "edge");
  const parsed = parseContainer(Buffer.from(result.blob), result.blockCols * result.blockRows);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.padding, "edge");
  assert.deepEqual(Array.from(parsed.steps), Array.from(steps));
  const fromBlob = readBlockCoefficients(Buffer.from(result.blob), 0, 0).map((row) => row.map((v) => (Object.is(v, -0) ? 0 : v)));
  assert.deepEqual(fromBlob, result.quantizedBlocks[0]);
});

test("known error: step 255 mid-gray constant decodes exactly; noisy image has bounded error", () => {
  const img = allFixtures().constant!;
  const decoded = decompress(compress(img, uniformSteps(255), "zero").blob);
  const report = computeError(img, decoded, "x");
  assert.equal(report.maxError, 0);

  const rand = allFixtures().random!;
  const r2 = computeError(rand, decompress(compress(rand, scaledSteps(60), "reflect").blob), "y");
  assert.ok(r2.mse > 0);
  assert.ok(r2.maxError <= 255);
  assert.ok(r2.psnrState === "finite" && r2.psnrDb! > 0);
});

test("damaged inputs are rejected", () => {
  const blob = Buffer.from(compress(allFixtures().gradient!, uniformSteps(8), "reflect").blob);
  assert.throws(() => decompress(blob.subarray(0, blob.length - 1)), (e: { code?: string }) => e.code === "TRUNCATED_PAYLOAD");
  const badMagic = Buffer.from(blob);
  badMagic[0] = 0x58;
  assert.throws(() => decompress(badMagic), (e: { code?: string }) => e.code === "BAD_MAGIC");
  const badVersion = Buffer.from(blob);
  badVersion[4] = 9;
  assert.throws(() => decompress(badVersion), (e: { code?: string }) => e.code === "INVALID_FORMAT_VERSION");
  assert.throws(() => decompress(Buffer.alloc(10)), (e: { code?: string }) => e.code === "TRUNCATED_PAYLOAD");
  const garbage = Buffer.concat([blob, Buffer.from([1])]);
  assert.throws(() => decompress(garbage), (e: { code?: string }) => e.code === "TRUNCATED_PAYLOAD");
});

test("non-positive quant steps and oversized dimensions are rejected", () => {
  const hasCode = (code: string) => (e: { code?: string }) => e.code === code;
  assert.throws(() => uniformSteps(0), hasCode("INVALID_QUANT_STEP"));
  assert.throws(() => uniformSteps(-3), hasCode("INVALID_QUANT_STEP"));
  const steps = uniformSteps(8);
  steps[0] = 0;
  assert.throws(() => compress({ width: 1, height: 1, pixels: [1] }, steps, "zero"), hasCode("INVALID_QUANT_STEP"));
  assert.throws(() => compress({ width: 70000, height: 1, pixels: [] }, uniformSteps(8), "zero"), hasCode("SIZE_OVERFLOW"));
  assert.throws(() => compress({ width: 2, height: 2, pixels: [1, 2, 3, 256] }, uniformSteps(8), "zero"), hasCode("INVALID_PIXEL_VALUE"));
});

test("serialize/reparse preserves payload for every fixture and padding mode", () => {
  for (const img of Object.values(allFixtures())) {
    for (const padding of ["zero", "edge", "reflect"] as const) {
      const result = compress(img, scaledSteps(25), padding);
      const reparsed = serializeContainer(parseContainer(Buffer.from(result.blob), result.blockCols * result.blockRows));
      assert.ok(reparsed.equals(result.blob));
    }
  }
});

test("block coordinates outside grid are rejected", () => {
  const blob = compress(allFixtures().gradient!, uniformSteps(8), "reflect").blob;
  assert.throws(() => readBlockCoefficients(Buffer.from(blob), 9, 9), CodecError);
});
