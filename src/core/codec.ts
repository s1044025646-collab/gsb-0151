import { BLOCK, dct2d, idct2d } from "./dct.js";
import { CodecError } from "./errors.js";
import { blockGrid, cropToOriginal, extractBlock, validateImage } from "./image.js";
import { dequantizeBlock, quantizeBlock, validateSteps } from "./quantize.js";
import { decodeBlock, encodeBlock } from "./rle.js";
import { fromZigzag, toZigzag } from "./zigzag.js";
import {
  FORMAT_VERSION,
  parseContainer,
  serializeContainer,
  type ContainerData,
} from "./container.js";
import type { GrayImage, PaddingStrategy } from "./types.js";

export interface CompressResult {
  blob: Buffer;
  byteLength: number;
  width: number;
  height: number;
  blockCols: number;
  blockRows: number;
  steps: number[];
  padding: PaddingStrategy;
  formatVersion: number;
  /** Per-block quantized coefficient matrices in natural order (for inspection). */
  quantizedBlocks: number[][][];
  zigzagBlocks: number[][];
}

/**
 * Compress an 8-bit grayscale image.
 * Pipeline: validate -> pad -> level shift (-128) -> 8x8 DCT -> quantize
 *           -> zigzag -> zero-run encode -> serialize GBC container.
 */
export function compress(img: GrayImage, steps: number[], padding: PaddingStrategy): CompressResult {
  validateImage(img);
  validateSteps(steps);
  const { cols, rows } = blockGrid(img.width, img.height);
  const quantizedBlocks: number[][][] = [];
  const zigzagBlocks: number[][] = [];
  const data: ContainerData = {
    version: FORMAT_VERSION,
    width: img.width,
    height: img.height,
    padding,
    steps,
    blocks: [],
  };
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const levelBlock = extractBlock(img, bx, by, padding);
      const coeffs = dct2d(levelBlock);
      // Steps are serialized as float32 in the container; quantize with the
      // same precision so encode/decode are bit-consistent.
      const storedSteps = steps.map((s) => Math.fround(s));
      const quantized = quantizeBlock(coeffs, storedSteps);
      const zig = toZigzag(quantized);
      quantizedBlocks.push(quantized);
      zigzagBlocks.push(zig);
      data.blocks.push(encodeBlock(zig).tokens);
    }
  }
  const blob = serializeContainer(data);
  return {
    blob,
    byteLength: blob.length,
    width: img.width,
    height: img.height,
    blockCols: cols,
    blockRows: rows,
    steps: steps.map((s) => Math.fround(s)),
    padding,
    formatVersion: FORMAT_VERSION,
    quantizedBlocks,
    zigzagBlocks,
  };
}

export interface DecompressResult extends GrayImage {
  blockCols: number;
  blockRows: number;
  padding: PaddingStrategy;
  steps: number[];
  version: number;
}

/**
 * Decompress using ONLY the bytes inside the container. The original image
 * is never read: dimensions, padding strategy and quant table all come from
 * the header; padded rows/columns are cropped to the stored original size.
 */
export function decompress(blob: Buffer): DecompressResult {
  // Peek dimensions to derive the expected block count from the header alone.
  if (!Buffer.isBuffer(blob) || blob.length < 11) {
    throw new CodecError("TRUNCATED_PAYLOAD", "data too short for GBC header");
  }
  const width = blob.readUInt16LE(5);
  const height = blob.readUInt16LE(7);
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const parsed = parseContainer(blob, cols * rows);
  validateSteps(parsed.steps);

  const pw = cols * BLOCK;
  const ph = rows * BLOCK;
  const padded = new Array<number>(pw * ph);
  let b = 0;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const zig = decodeBlock(parsed.blocks[b]!);
      const quantized = fromZigzag(zig);
      const coeffs = dequantizeBlock(quantized, parsed.steps);
      // Pin reconstructed coefficients to the float32 precision used to store
      // the quantization steps, making reconstruction deterministic and
      // avoiding 1-ulp drift from 64-term basis accumulation.
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) coeffs[y]![x] = Math.fround(coeffs[y]![x]!);
      const level = idct2d(coeffs);
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const v = level[y]![x]! + 128;
          // Pixel clipping: round half-up then clamp to [0,255].
          let s = Math.round(v);
          if (s === 0) s = 0;
          if (s < 0) s = 0;
          else if (s > 255) s = 255;
          padded[(by * BLOCK + y) * pw + (bx * BLOCK + x)] = s;
        }
      }
      b++;
    }
  }
  const pixels = cropToOriginal(padded, pw, parsed.width, parsed.height);
  return {
    width: parsed.width,
    height: parsed.height,
    pixels,
    blockCols: cols,
    blockRows: rows,
    padding: parsed.padding,
    steps: parsed.steps,
    version: parsed.version,
  };
}

/** Return quantized coefficients of one block from a compressed blob. */
export function readBlockCoefficients(blob: Buffer, bx: number, by: number): number[][] {
  const width = blob.readUInt16LE(5);
  const height = blob.readUInt16LE(7);
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  if (bx < 0 || by < 0 || bx >= cols || by >= rows) {
    throw new CodecError("NOT_FOUND", `block (${bx},${by}) out of grid ${cols}x${rows}`);
  }
  const parsed = parseContainer(blob, cols * rows);
  const zig = decodeBlock(parsed.blocks[by * cols + bx]!);
  return fromZigzag(zig);
}
