import { BLOCK } from './dct';
import { fail } from './errors';

export const MAX_RUN = 15; // 4-bit run field; 15 means "15 zeros, value follows"

export interface RunToken {
  run: number; // number of zero AC coefficients preceding `value`
  value: number; // signed coefficient level (0 only valid for EOB marker)
}

export const EOB: RunToken = { run: 0, value: 0 };

// Encode a 64-entry zig-zag scan sequence (DC first, then 63 AC values).
// Trailing zeros are dropped and represented by a single EOB token.
export function encodeRle(sequence: readonly number[]): RunToken[] {
  if (sequence.length !== BLOCK * BLOCK) {
    fail('VALIDATION', `RLE input must contain ${BLOCK * BLOCK} coefficients`);
  }
  const tokens: RunToken[] = [];
  tokens.push({ run: 0, value: sequence[0] });

  let run = 0;
  for (let i = 1; i < sequence.length; i++) {
    const v = sequence[i];
    if (v === 0) {
      run++;
      if (run > MAX_RUN) {
        tokens.push({ run: MAX_RUN, value: 0 });
        run -= MAX_RUN;
      }
    } else {
      if (run > MAX_RUN) fail('INVALID_RUN', 'run length overflow while encoding');
      tokens.push({ run, value: v });
      run = 0;
    }
  }
  if (run > 0) tokens.push(EOB);
  return tokens;
}

// Decode tokens back to the 64-entry scan sequence; rejects over-long runs.
export function decodeRle(tokens: readonly RunToken[]): number[] {
  if (tokens.length === 0) fail('INVALID_RUN', 'block has no tokens');
  const out = new Array<number>(BLOCK * BLOCK).fill(0);
  let pos = 0;
  for (let t = 0; t < tokens.length; t++) {
    const { run, value } = tokens[t];
    if (t === 0) {
      if (run !== 0) fail('INVALID_RUN', 'DC token must have zero run');
      out[0] = value;
      pos = 1;
      continue;
    }
    if (run < 0 || run > MAX_RUN || !Number.isInteger(run)) {
      fail('INVALID_RUN', `run field out of range: ${run}`);
    }
    if (value === 0) {
      // EOB or (15,0) continuation. A (15,0) token consumes 15 zero positions.
      pos += run;
      if (run !== MAX_RUN) {
        // true EOB: must be final token
        if (t !== tokens.length - 1) fail('INVALID_RUN', 'EOB must be the final token');
        if (pos > BLOCK * BLOCK) fail('INVALID_RUN', 'EOB run overruns block');
        return out;
      }
      if (pos > BLOCK * BLOCK) fail('INVALID_RUN', 'zero run overruns block');
    } else {
      pos += run;
      if (pos >= BLOCK * BLOCK) fail('INVALID_RUN', 'nonzero token overruns block');
      out[pos] = value;
      pos += 1;
    }
  }
  if (pos > BLOCK * BLOCK) fail('INVALID_RUN', 'token stream overruns block');
  return out;
}
