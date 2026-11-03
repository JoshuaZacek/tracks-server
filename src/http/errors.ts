/**
 * Stable, machine-readable error codes. The iOS app switches on `code`; `message`
 * is for logs and developers. Add codes, never rename them.
 */
export const ERROR_CODES = [
  'validation_failed',
  'invalid_json',
  'payload_too_large',
  'unauthorized',
  'not_found',
  'station_not_found',
  'train_not_running',
  'journey_not_found',
  'station_not_on_route',
  'schedule_not_loaded',
  'rate_limited',
  'not_implemented',
  'service_unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }

  static validation(details: unknown, message = 'The request is not valid') {
    return new ApiError(400, 'validation_failed', message, details);
  }

  static unauthorized(message = 'A valid device token is required') {
    return new ApiError(401, 'unauthorized', message);
  }

  static notFound(code: Extract<ErrorCode, 'not_found' | 'station_not_found' | 'train_not_running' | 'journey_not_found'>, message: string) {
    return new ApiError(404, code, message);
  }

  /** For endpoints whose data source arrives in a later phase (see the implementation plan). */
  static notImplemented(phase: string) {
    return new ApiError(501, 'not_implemented', `Not implemented yet (${phase})`);
  }
}
