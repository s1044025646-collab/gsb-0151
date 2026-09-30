import { GrayImage, makeImage } from './image';

// Deterministic PRNG (mulberry32) so fixtures and tests are reproducible
// without relying on ambient randomness.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function constantImage(width: number, height: number, value: number): GrayImage {
  return makeImage(width, height, new Array<number>(width * height).fill(value));
}

export function gradientImage(width: number, height: number): GrayImage {
  const pixels = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = Math.round((x / Math.max(1, width - 1)) * 255);
    }
  }
  return makeImage(width, height, pixels);
}

export function checkerImage(width: number, height: number, cell = 4): GrayImage {
  const pixels = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
    }
  }
  return makeImage(width, height, pixels);
}

export function pulseImage(width: number, height: number, px: number, py: number): GrayImage {
  const pixels = new Array<number>(width * height).fill(0);
  pixels[py * width + px] = 255;
  return makeImage(width, height, pixels);
}

export function randomImage(width: number, height: number, seed = 1234): GrayImage {
  const rand = mulberry32(seed);
  const pixels = new Array<number>(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(rand() * 256);
  return makeImage(width, height, pixels);
}

// Full fixture matrix including non-multiple-of-eight dimensions.
export function standardFixtureSet(): Record<string, GrayImage> {
  return {
    constant: constantImage(16, 16, 77),
    gradient: gradientImage(24, 24),
    checker: checkerImage(16, 16, 4),
    pulse: pulseImage(16, 16, 5, 9),
    random: randomImage(16, 16, 42),
    odd_width: gradientImage(13, 8),
    odd_height: gradientImage(8, 11),
    odd_both: randomImage(17, 23, 7),
  };
}
