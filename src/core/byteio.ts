import { fail } from './errors';

export class ByteWriter {
  private chunks: number[] = [];

 get length(): number {
    return this.chunks.length;
  }

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail('VALIDATION', `u8 out of range: ${value}`);
    }
    this.chunks.push(value);
    return this;
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      fail('DIMENSION_OVERFLOW', `u16 out of range: ${value}`);
    }
    this.chunks.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      fail('VALIDATION', `u32 out of range: ${value}`);
    }
    this.chunks.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    return this;
  }

  bytes(data: ArrayLike<number>): this {
    for (let i = 0; i < data.length; i++) this.u8(data[i]);
    return this;
  }

  ascii(text: string): this {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 127) fail('VALIDATION', 'ascii field contains non-ascii character');
      this.u8(code);
    }
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.chunks);
  }
}

export class ByteReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  get pos(): number {
    return this.offset;
  }
  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  require(count: number): void {
    if (this.remaining < count) {
      fail('TRUNCATED_PAYLOAD', `need ${count} bytes at offset ${this.offset}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.require(1);
    return this.buffer[this.offset++];
  }

  u16(): number {
    this.require(2);
    const v = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.require(4);
    const v = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  bytes(count: number): Buffer {
    this.require(count);
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return Buffer.from(slice);
  }

  ascii(count: number): string {
    return this.bytes(count).toString('ascii');
  }

  expectEnd(): void {
    if (this.remaining !== 0) {
      fail('TRUNCATED_PAYLOAD', `unexpected trailing bytes: ${this.remaining}`);
    }
  }
}

// Zig-zag signed integer encoding: maps signed values to an unsigned order.
// 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4, ...
export function zigEncode(value: number): number {
  if (!Number.isInteger(value)) fail('VALIDATION', 'coefficient level must be an integer');
  return value >= 0 ? value * 2 : value * -2 - 1;
}

export function zigDecode(order: number): number {
  if (!Number.isInteger(order) || order < 0) fail('INVALID_RUN', 'corrupt signed encoding');
  return order % 2 === 0 ? order / 2 : -(order + 1) / 2;
}
