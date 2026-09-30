import { N, BLOCK } from './dct';

// Standard diagonal zig-zag ordering of the 64 positions inside an 8x8 block.
export const ZIGZAG: ReadonlyArray<readonly [number, number]> = (() => {
  const order: Array<[number, number]> = [];
  for (let s = 0; s <= 2 * (N - 1); s++) {
    const cells: Array<[number, number]> = [];
    for (let r = 0; r < N; r++) {
      const c = s - r;
      if (c >= 0 && c < N) cells.push([r, c]);
    }
    if (s % 2 === 1) cells.reverse();
    for (const cell of cells) order.push(cell);
  }
  return order;
})();

export function scan(coeffs: number[][]): number[] {
  const out = new Array<number>(BLOCK * BLOCK);
  for (let i = 0; i < ZIGZAG.length; i++) {
    const [r, c] = ZIGZAG[i];
    out[i] = coeffs[r][c];
  }
  return out;
}

export function unscan(sequence: readonly number[]): number[][] {
  const block = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  if (sequence.length !== BLOCK * BLOCK) {
    throw new Error(`scan sequence must contain ${BLOCK * BLOCK} coefficients`);
  }
  for (let i = 0; i < ZIGZAG.length; i++) {
    const [r, c] = ZIGZAG[i];
    block[r][c] = sequence[i];
  }
  return block;
}
