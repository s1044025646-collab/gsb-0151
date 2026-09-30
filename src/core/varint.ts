import { ByteReader, ByteWriter } from './byteio';
import { fail } from './errors';

export function writeVarint(w: ByteWriter, value: number): void {
  if (!Number.isInteger(value) || value < 0) fail('VALIDATION', 'varint must be a non-negative integer');
  let v = value;
  while (v >= 0x80) {
    w.u8((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  w.u8(v);
}

export function readVarint(r: ByteReader): number {
  let result = 0;
  let shift = 1;
  for (let i = 0; i < 6; i++) {
    const byte = r.u8();
    if (i === 5 && byte > 0x0f) fail('TRUNCATED_PAYLOAD', 'varint exceeds 32 bits');
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) {
      if (result > 0xffffffff) fail('TRUNCATED_PAYLOAD', 'varint value overflow');
      return result;
    }
    shift *= 128;
  }
  fail('TRUNCATED_PAYLOAD', 'varint terminator missing');
}
