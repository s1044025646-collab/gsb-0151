// Public container format "GBC1" (Gray Block Codec, version 1).
// This is a self-designed format; it is NOT compatible with JPEG.
//
// Layout (all multi-byte integers little-endian unless noted):
//   magic        4 bytes  ASCII "GBC1"
//   version      u8       format version (must equal 1)
//   width        u16      original width  in pixels
//   height       u16      original height in pixels
//   padding      u8       0 = zero padding, 1 = edge replication
//   reserved     u8       must be 0
//   quant[64]    64 x u16 quantization steps, natural row-major order
//   blocks       varint   number of 8x8 blocks (pw/8 * ph/8)
//   then, per block, token count then (run:u4,zzvalue:varint) tokens;
//   DC is always the first token with run=0.

import { ByteReader, ByteWriter, zigDecode, zigEncode } from './byteio';
import { BLOCK } from './dct';
import { fail } from './errors';
import { decodeRle, encodeRle, EOB, RunToken } from './rle';
import { validateQuantTable } from './quantize';
import { readVarint, writeVarint } from './varint';
import { scan as zigScan, unscan as zigUnscan } from './zigzag';

export const MAGIC = 'GBC1';
export const FORMAT_VERSION = 1;

export type PaddingCode = 0 | 1;

export interface CompressedImage {
  width: number;
  height: number;
  padding: 'zero' | 'edge';
  quant: number[];
  // one level matrix per 8x8 block in row-major block order
  blocks: number[][][];
  serializedBytes: number;
}

export function paddingToCode(padding: 'zero' | 'edge'): PaddingCode {
  if (padding === 'zero') return 0;
  if (padding === 'edge') return 1;
  return fail('INVALID_PADDING', `unknown padding strategy: ${String(padding)}`);
}

export function codeToPadding(code: number): 'zero' | 'edge' {
  if (code === 0) return 'zero';
  if (code === 1) return 'edge';
 return fail('INVALID_PADDING', `unknown padding code: ${code}`);
}

export function serializeContainer(input: Omit<CompressedImage, 'serializedBytes'>): Buffer {
  validateQuantTable(input.quant);
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) ||
      input.width <= 0 || input.height <= 0 || input.width > 65535 || input.height > 65535) {
    fail('DIMENSION_OVERFLOW', 'container dimensions must fit in u16');
  }
  const w = new ByteWriter();
  w.ascii(MAGIC);
  w.u8(FORMAT_VERSION);
  w.u16(input.width);
  w.u16(input.height);
  w.u8(paddingToCode(input.padding));
  w.u8(0);
  for (const step of input.quant) {
    if (!Number.isInteger(step) || step < 1 || step > 65535) {
      fail('INVALID_QUANT_STEP', 'serialized quant steps must be integers in [1,65535]');
    }
    w.u16(step);
  }
  writeVarint(w, input.blocks.length);

  for (const block of input.blocks) {
    const sequence = zigScan(block);
    const tokens = encodeRle(sequence);
    writeVarint(w, tokens.length);
    for (const token of tokens) {
      if (token.run < 0 || token.run > 15) fail('INVALID_RUN', 'run field exceeds 4 bits');
      w.u8(token.run);
      writeVarint(w, zigEncode(token.value));
    }
  }
  return w.toBuffer();
}

export function parseContainer(buffer: Buffer): CompressedImage {
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== MAGIC) {
    fail('BAD_MAGIC', 'not a GBC1 container');
  }
  const r = new ByteReader(buffer);
  r.ascii(4);
  const version = r.u8();
  if (version !== FORMAT_VERSION) {
    fail('UNSUPPORTED_VERSION', `unsupported container version: ${version}`);
  }
  const width = r.u16();
  const height = r.u16();
  if (width === 0 || height === 0) fail('DIMENSION_OVERFLOW', 'zero dimension in header');
  const padding = codeToPadding(r.u8());
  const reserved = r.u8();
  if (reserved !== 0) fail('CORRUPT_HEADER', `reserved byte must be 0, got ${reserved}`);

  const quant: number[] = [];
  for (let i = 0; i < BLOCK * BLOCK; i++) {
    const step = r.u16();
    if (step === 0) fail('INVALID_QUANT_STEP', `quant step at index ${i} is zero`);
    quant.push(step);
  }

  const blockCount = readVarint(r);
  const expectedCols = Math.ceil(width / BLOCK);
  const expectedRows = Math.ceil(height / BLOCK);
  if (blockCount !== expectedRows * expectedCols) {
    fail('CORRUPT_HEADER', `block count ${blockCount} does not match dimensions ${width}x${height}`);
  }

  const blocks: number[][][] = [];
  for (let b = 0; b < blockCount; b++) {
    const tokenCount = readVarint(r);
    if (tokenCount === 0 || tokenCount > 64 + 8) fail('INVALID_RUN', 'token count out of range');
    const tokens: RunToken[] = [];
    for (let t = 0; t < tokenCount; t++) {
      const runNibble = r.u8();
      if (runNibble > 15 || (t === 0 && runNibble !== 0)) {
        fail('INVALID_RUN', 'run nibble out of range');
      }
      const value = zigDecode(readVarint(r));
      tokens.push({ run: runNibble, value });
    }
    // Strict EOB placement: encode always emits EOB when trailing zeros exist.
    const sequence = decodeRle(tokens);
    blocks.push(zigUnscan(sequence));
  }
  r.expectEnd();

  return { width, height, padding, quant, blocks, serializedBytes: buffer.length };
}

export { EOB };
