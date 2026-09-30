import { BLOCK } from "./dct.js";
import { CodecError } from "./errors.js";
import type { RleToken } from "./rle.js";
import { decodeBlock } from "./rle.js";
import type { PaddingStrategy } from "./types.js";
import { validateSteps } from "./quantize.js";

/**
 * GBC (Gray Block Codec) container — an original, self-described format.
 * This is NOT compatible with JPEG or any other standard.
 *
 * Layout (all multi-byte integers little-endian):
 *   offset 0   char[4]  magic "GBC1"
 *   offset 4   u8       format version (1)
 *   offset 5   u16      original width  (1..65535)
 *   offset 7   u16      original height (1..65535)
 *   offset 9   u8       padding strategy: 0=zero, 1=edge, 2=reflect
 *   offset 10  u8       reserved (must be 0)
 *   offset 11  f32[64]  quantization steps in natural (row,col) order
 *   offset 267 ...      payload, one entry per 8x8 block in raster order
 * Per block:
 *   u16 tokenCount
 *   repeated tokenCount times:
 *     u8     run (0..63)
 *     sVar   coefficient value: signed LEB128 (zigzag-mapped), non-zero
 * Trailing all-zero coefficients are omitted (implicit end of block).
 */

export const MAGIC = Buffer.from("GBC1", "ascii");
export const FORMAT_VERSION = 1;
export const HEADER_LENGTH = 11 + BLOCK * BLOCK * 4; // 267

const PADDING_CODES: Record<PaddingStrategy, number> = { zero: 0, edge: 1, reflect: 2 };
const PADDING_NAMES: PaddingStrategy[] = ["zero", "edge", "reflect"];

export interface ContainerData {
  version: number;
  width: number;
  height: number;
  padding: PaddingStrategy;
  steps: number[];
  blocks: RleToken[][];
}

class ByteWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }
  u8(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    this.push(b);
  }
  u16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.push(b);
  }
  f32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.push(b);
  }
  /** Signed LEB128 with zigzag mapping. */
  svar(value: number): void {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new CodecError("INVALID_COEFFICIENT", "coefficient must be a signed 32-bit integer", value);
    }
    let n = ((value << 1) ^ (value >> 31)) >>> 0;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.u8(n & 0x7f);
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

class ByteReader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

 need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new CodecError("TRUNCATED_PAYLOAD", "unexpected end of compressed data", {
        offset: this.pos,
        needed: n,
        size: this.buf.length,
      });
    }
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  svar(): number {
    let shift = 0;
    let n = 0;
    let byte: number;
    do {
      if (shift > 28) throw new CodecError("TRUNCATED_PAYLOAD", "varint too long");
      byte = this.u8();
      n |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    n = n >>> 0;
    return (n >>> 1) ^ -(n & 1);
  }
}

export function serializeContainer(data: ContainerData): Buffer {
  if (data.version !== FORMAT_VERSION) {
    throw new CodecError("INVALID_FORMAT_VERSION", `unsupported version ${data.version}`);
  }
  validateSteps(data.steps);
  const w = new ByteWriter();
  w.push(MAGIC);
  w.u8(FORMAT_VERSION);
  w.u16(data.width);
  w.u16(data.height);
  w.u8(PADDING_CODES[data.padding]!);
  w.u8(0);
  for (const s of data.steps) w.f32(s);
  for (const tokens of data.blocks) {
    if (tokens.length > 0xffff) {
      throw new CodecError("INVALID_RUN", "too many tokens in one block");
    }
    w.u16(tokens.length);
    for (const t of tokens) {
      w.u8(t.run);
      w.svar(t.value);
    }
  }
  return w.buffer();
}

export function parseContainer(buf: Buffer, expectedBlocks: number): ContainerData {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LENGTH) {
    throw new CodecError("TRUNCATED_PAYLOAD", "file smaller than fixed header");
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new CodecError("BAD_MAGIC", "not a GBC container (bad magic)");
  }
  const r = new ByteReader(buf);
  r.pos = 4;
  const version = r.u8();
  if (version !== FORMAT_VERSION) {
    throw new CodecError("INVALID_FORMAT_VERSION", `unsupported format version ${version}`);
  }
  const width = r.u16();
  const height = r.u16();
  if (width === 0 || height === 0) {
    throw new CodecError("INVALID_DIMENSIONS", "stored dimensions must be positive");
  }
  const padCode = r.u8();
  const reserved = r.u8();
  if (padCode > 2) throw new CodecError("INVALID_PADDING", `unknown padding code ${padCode}`);
  if (reserved !== 0) throw new CodecError("INVALID_HEADER", "reserved byte must be zero");
  const steps: number[] = [];
  for (let i = 0; i < 64; i++) steps.push(r.f32());
  validateSteps(steps);

  const blocks: RleToken[][] = [];
  for (let b = 0; b < expectedBlocks; b++) {
    const tokenCount = r.u16();
    const tokens: RleToken[] = [];
    for (let i = 0; i < tokenCount; i++) {
      const run = r.u8();
      const value = r.svar();
      tokens.push({ run, value });
    }
    // Full validation here: illegal runs / overrun are rejected at parse time.
    decodeBlock(tokens);
    blocks.push(tokens);
  }
  if (r.pos !== buf.length) {
    throw new CodecError("TRUNCATED_PAYLOAD", "trailing garbage bytes after payload", {
      consumed: r.pos,
      size: buf.length,
    });
  }
  return { version, width, height, padding: PADDING_NAMES[padCode]!, steps, blocks };
}
