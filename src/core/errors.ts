export type ErrorCode =
  | 'VALIDATION'
  | 'DIMENSION_OVERFLOW'
  | 'INVALID_PIXEL'
  | 'INVALID_QUANT_STEP'
  | 'INVALID_PADDING'
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'TRUNCATED_PAYLOAD'
  | 'INVALID_RUN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CORRUPT_HEADER';

export class CodecError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new CodecError(code, message);
}
