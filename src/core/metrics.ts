import { CodecError } from "./errors.js";
import type { GrayImage } from "./types.js";
import type { ErrorReport } from "./types.js";

/**
 * Error metrics are computed over ORIGINAL VALID PIXELS ONLY
 * (width*height). Padding samples never enter the sums.
 */
export function computeError(
  original: GrayImage,
  reconstructed: GrayImage,
  artifactId: string,
): ErrorReport {
  if (original.width !== reconstructed.width || original.height !== reconstructed.height) {
    throw new CodecError(
      "VALIDATION",
      "dimension mismatch between original and reconstruction",
      { original, reconstructed },
    );
  }
  const n = original.width * original.height;
  const errorMatrix = new Array<number>(n);
  let sumSq = 0;
  let maxError = 0;
  for (let i = 0; i < n; i++) {
    const diff = original.pixels[i]! - reconstructed.pixels[i]!;
    errorMatrix[i] = diff;
    sumSq += diff * diff;
    const abs = Math.abs(diff);
    if (abs > maxError) maxError = abs;
  }
  const mse = sumSq / n;
  let psnrDb: number | null = null;
  let psnrState: "finite" | "infinite" = "finite";
  if (mse === 0) {
    // Explicit state: zero error -> infinite PSNR.
    psnrState = "infinite";
    psnrDb = null;
  } else {
    psnrDb = 10 * Math.log10((255 * 255) / mse);
  }
  return {
    artifactId,
    imageId: (original as { id?: string }).id ?? "",
    width: original.width,
    height: original.height,
    mse,
    psnrDb,
    psnrState,
    maxError,
    errorMatrix,
  };
}

export function formatPsnr(report: Pick<ErrorReport, "psnrDb" | "psnrState">): string {
  return report.psnrState === "infinite" ? "Infinity dB (zero error)" : `${report.psnrDb!.toFixed(4)} dB`;
}
