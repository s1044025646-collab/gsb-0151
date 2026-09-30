import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, forwardDCT, inverseDCT, createBlock } from '../core/dct';
import { scan, unscan, ZIGZAG } from '../core/zigzag';
import { encodeRle, decodeRle, MAX_RUN } from '../core/rle';
import { CodecError } from '../core/errors';
import {
  constantImage,
  gradientImage,
  checkerImage,
  pulseImage,
  randomImage,
} from '../core/fixtures';
import { compressImage, decompressContainer, compareImages } from '../core/codec';
import { parseContainer } from '../core/container';
import { uniformTable } from '../core/quantize';

test('zig-zag visits all 64 positions exactly once', () => {
  assert.equal(ZIGZAG.length, 64);
  const seen = new Set<string>();
  for (const [r, c] of ZIGZAG) seen.add(`${r},${c}`);
  assert.equal(seen.size, 64);
  assert.deepEqual([ZIGZAG[0], ZIGZAG[1], ZIGZAG[2]], [[0, 0], [1, 0], [0, 1]]);
  const probe = randomBlock();
  assert.deepEqual(scan(unscan(scan(probe))), scan(probe));
});

test('forward/inverse DCT round trip without quantization (lossless)', () => {
  const block = centeredBlock([
    [10, 20, 30, 40, 50, 60, 70, 80],
    [5, 15, 25, 35, 45, 55, 65, 75],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [100, 90, 80, 70, 60, 50, 40, 30],
    [12, -34, 56, -78, 90, -12, 34, -56],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [255 - 128, 0 - 128, 128 - 128, 10, 20, 30, 40, 50],
    [7, 7, 7, 7, 8, 8, 8, 8],
  ]);
  const back = inverseDCT(forwardDCT(block));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      assert.ok(Math.abs(back[r][c] - block[r][c]) < 1e-9, `mismatch at ${r},${c}`);
    }
  }
});

test('orthonormal DCT preserves energy (Parseval)', () => {
  const block = centeredBlock([
    [12, 45, -90, 33, 21, 7, -5, 90],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [8, 7, 6, 5, 4, 3, 2, 1],
    [100, -100, 50, -50, 25, -25, 0, 0],
    [13, 26, 39, 52, 65, 78, 91, 104],
    [11, 22, 33, 44, 55, 66, 77, 88],
    [-12, -24, -36, -48, -60, -72, -84, -96],
  ]);
  const coeffs = forwardDCT(block);
  let spatialEnergy = 0;
  let freqEnergy = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      spatialEnergy += block[r][c] ** 2;
      freqEnergy += coeffs[r][c] ** 2;
    }
  }
  assert.ok(Math.abs(spatialEnergy - freqEnergy) / spatialEnergy < 1e-10);
});

test('RLE restores sequences including long zero runs and EOB', () => {
  const seq = new Array<number>(64).fill(0);
  seq[0] = 12;
  seq[20] = -3; // 19 preceding AC zeros -> run split across 15
  seq[63] = 4;
  const tokens = encodeRle(seq);
  assert.deepEqual(decodeRle(tokens), seq);

  const allZero = new Array<number>(64).fill(0);
  allZero[0] = 2;
  assert.deepEqual(decodeRle(encodeRle(allZero)), allZero);

  const noTrailZero = Array.from({ length: 64 }, (_, i) => (i % 3 === 0 ? 1 : i % 3));
  noTrailZero[0] = 9;
  assert.deepEqual(decodeRle(encodeRle(noTrailZero)), noTrailZero);
  assert.equal(MAX_RUN, 15);
});

test('RLE rejects illegal runs', () => {
  assert.throws(
    () => decodeRle([{ run: 0, value: 1 }, { run: 16, value: 1 }]),
    (err: Error) => err instanceof CodecError && err.code === 'INVALID_RUN'
  );
  // EOB placed before another token is illegal.
  assert.throws(
    () => decodeRle([{ run: 0, value: 1 }, { run: 2, value: 0 }, { run: 0, value: 5 }]),
    (err: Error) => err instanceof CodecError && err.code === 'INVALID_RUN'
  );
});

test('integer-level quant (step=1) is exact for constant blocks; lossless transform covered by DCT test', () => {
  const images = [
    constantImage(16, 16, 77),
  ];
  for (const image of images) {
    for (const padding of ['zero', 'edge'] as const) {
      const { container } = compressImage(image, uniformTable(1), padding);
      const rebuilt = decompressContainer(container);
      const report = compareImages(image, rebuilt);
      assert.equal(report.maxError, 0, `constant ${image.width}x${image.height} ${padding}`);
      assert.equal(report.psnrState, 'infinity');
      assert.equal(report.psnr, null);
      assert.deepEqual(Array.from(rebuilt.pixels), Array.from(image.pixels));
    }
  }
});

test('step=1 keeps non-constant fixtures bounded to +/-1; edge padding handles odd sizes', () => {
  const odd = gradientImage(13, 11);
  for (const image of [odd, checkerImage(17, 19, 4), pulseImage(16, 16, 5, 9), randomImage(23, 9, 42)]) {
    for (const padding of ['zero', 'edge'] as const) {
      const report = compareImages(image, decompressContainer(compressImage(image, uniformTable(1), padding).container));
      assert.ok(report.maxError <= 1, `${image.width}x${image.height} ${padding} maxError=${report.maxError}`);
    }
  }
});

test('decompress trims padding for non-multiple-of-eight sizes', () => {
  const image = randomImage(13, 7, 5);
  const { container } = compressImage(image, uniformTable(1), 'edge');
  const rebuilt = decompressContainer(container);
  assert.equal(rebuilt.width, 13);
  assert.equal(rebuilt.height, 7);
  assert.equal(rebuilt.pixels.length, 91);
});

test('serialized byte length is the real container size', () => {
  const image = checkerImage(16, 16, 4);
  const { container, bytes } = compressImage(image, uniformTable(10), 'zero');
  assert.equal(bytes, container.length);
  const parsed = parseContainer(container);
  assert.equal(parsed.serializedBytes, container.length);
  const nonZeroCount = parsed.blocks.reduce(
    (sum, block) => sum + block.flat().filter((v) => v !== 0).length,
    0
  );
  assert.ok(bytes !== nonZeroCount);
});

test('known error on constant image with coarse quantization', () => {
  const image = constantImage(8, 8, 200);
  const { container } = compressImage(image, uniformTable(50), 'zero');
  const rebuilt = decompressContainer(container);
  // Orhonormal DC = sqrt(64) * 72 = 576; /50 rounds to 12 (half away from zero);
  // 12*50/sqrt(64) = 75 centered -> pixel 128 + round(75) = 203. Uniform +3 error.
  assert.equal(rebuilt.pixels[0], 203);
  const report = compareImages(image, rebuilt);
  assert.equal(report.maxError, 3);
  assert.equal(report.mse, 9);
});

test('container independently decodes from bytes only', () => {
  const image = randomImage(16, 16, 99);
  const { container } = compressImage(image, uniformTable(12), 'edge');
  // Fresh parse from a copied Buffer; no access to the original image object.
  const copy = Buffer.from(container);
  const parsed = parseContainer(copy);
  assert.equal(parsed.width, 16);
  assert.equal(parsed.height, 16);
  assert.equal(parsed.padding, 'edge');
  assert.equal(parseContainerHeaderVersion(copy), 1);
  const rebuilt = decompressContainer(copy);
  assert.equal(rebuilt.pixels.length, 256);
});

function parseContainerHeaderVersion(buffer: Buffer): number {
  return buffer[4];
}

test('different parameters produce distinct independent artifacts', () => {
  const image = gradientImage(16, 16);
  const a = compressImage(image, uniformTable(5), 'zero').container;
  const b = compressImage(image, uniformTable(20), 'zero').container;
  const c = compressImage(image, uniformTable(5), 'edge').container;
  assert.notDeepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test('corrupt and truncated payloads are rejected with explicit codes', () => {
  const image = randomImage(16, 16, 3);
  const good = compressImage(image, uniformTable(8), 'zero').container;

  const badMagic = Buffer.from(good);
  badMagic.write('XXXX', 0, 'ascii');
  assert.throws(() => parseContainer(badMagic), (err: Error) => {
    return err instanceof CodecError && err.code === 'BAD_MAGIC';
  });

  const badVersion = Buffer.from(good);
  badVersion[4] = 9;
  assert.throws(() => parseContainer(badVersion), (err: Error) => err instanceof CodecError && err.code === 'UNSUPPORTED_VERSION');

  assert.throws(() => parseContainer(good.subarray(0, good.length - 3)), (err: Error) => {
    return err instanceof CodecError && err.code === 'TRUNCATED_PAYLOAD';
  });

  assert.throws(() => parseContainer(Buffer.concat([good, Buffer.from([1, 2, 3])])), (err: Error) => {
    return err instanceof CodecError && err.code === 'TRUNCATED_PAYLOAD';
  });

  // zero quant step in header
  const zeroStep = Buffer.from(good);
  // quant table starts at offset 10
  zeroStep.writeUInt16LE(0, 10);
  assert.throws(() => parseContainer(zeroStep), (err: Error) => (err as CodecError).code === 'INVALID_QUANT_STEP');
});

test('invalid dimensions and pixels rejected', () => {
  assert.throws(() => constantImage(0, 8, 10), CodecError);
  assert.throws(() => constantImage(70000, 1, 10), CodecError);
  const { makeImage } = require('../core/image');
  assert.throws(() => makeImage(2, 2, [0, 256, 0, 0]), CodecError);
  assert.throws(() => makeImage(2, 2, [0, -1, 0, 0]), CodecError);
});

test('non-positive quant steps rejected', () => {
  assert.throws(() => uniformTable(0), CodecError);
  assert.throws(() => uniformTable(-3), CodecError);
  assert.throws(() => compressImage(constantImage(8, 8, 10), uniformTable(NaN), 'zero'), CodecError);
});

function randomBlock(): number[][] {
  const block = createBlock();
  for (let r = 0; r < BLOCK; r++) for (let c = 0; c < BLOCK; c++) block[r][c] = (r * 31 + c * 7) % 20 - 10;
  return block;
}

function centeredBlock(rows: number[][]): number[][] {
  return rows.map((row) => row.slice());
}

