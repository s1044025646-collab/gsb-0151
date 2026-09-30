import { BLOCK } from "./dct.js";
import { CodecError } from "./errors.js";

export interface RleToken {
  /** Number of zero coefficients preceding `value` (max 63 within one block). */
  run: number;
  /** Non-zero coefficient value. */
  value: number;
}

export interface EncodedBlock {
  tokens: RleToken[];
}

export const MAX_RUN = BLOCK * BLOCK - 1; // 63

/**
 * Encode one block's zigzag-order coefficients.
 * Trailing all-zero coefficients are dropped (implicit end-of-block).
 */
export function encodeBlock(zig: number[]): EncodedBlock {
  if (zig.length !== BLOCK * BLOCK) {
    throw new CodecError("INVALID_COEFFICIENT", "block must contain 64 coefficients");
  }
  const tokens: RleToken[] = [];
  let run = 0;
  for (let i = 0; i < zig.length; i++) {
    const v = zig[i]!;
    if (v === 0) {
      run++;
    } else {
      tokens.push({ run, value: v });
      run = 0;
    }
  }
  return { tokens };
}

/** Decode tokens back to 64 zigzag coefficients; rejects illegal runs. */
export function decodeBlock(tokens: RleToken[]): number[] {
  const out = new Array<number>(BLOCK * BLOCK).fill(0);
  let pos = 0;
  for (const token of tokens) {
    if (!Number.isInteger(token.run) || token.run < 0 || token.run > MAX_RUN) {
      throw new CodecError("INVALID_RUN", `run length out of range [0,${MAX_RUN}]`, token);
    }
    if (!Number.isInteger(token.value) || token.value === 0) {
      throw new CodecError("INVALID_COEFFICIENT", "RLE value must be a non-zero integer", token);
    }
    pos += token.run;
    if (pos >= BLOCK * BLOCK) {
      throw new CodecError("INVALID_RUN", "run skips past end of block", token);
    }
    out[pos] = token.value;
    pos++;
  }
  return out;
}
