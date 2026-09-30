export type ErrorCode =
  | "INVALID_DIMENSIONS"
  | "INVALID_PIXEL_VALUE"
  | "SIZE_OVERFLOW"
  | "INVALID_QUANT_STEP"
  | "INVALID_PADDING"
  | "INVALID_FORMAT_VERSION"
  | "BAD_MAGIC"
  | "TRUNCATED_PAYLOAD"
  | "INVALID_RUN"
  | "INVALID_COEFFICIENT"
  | "INVALID_HEADER"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "IDEMPOTENT_REPLAY";

export class CodecError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CodecError";
    this.code = code;
    this.details = details;
  }
}

export function errorStatusCode(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "IDEMPOTENT_REPLAY":
      return 409;
    default:
      return 400;
  }
}
