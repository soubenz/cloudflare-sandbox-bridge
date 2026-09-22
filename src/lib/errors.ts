/**
 * ApiError is the only error type route handlers throw. `toResponse()` is
 * the single place that turns an error into an HTTP response, so every
 * route gets consistent status/code/body shape without repeating try/catch
 * boilerplate.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toResponse(): Response {
    return Response.json(
      { error: { code: this.code, message: this.message, details: this.details } },
      { status: this.status }
    );
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  }
  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'Missing or invalid credentials'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }
  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }
  static payloadTooLarge(message: string): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }
  static unavailable(message: string, retryAfterMs?: number): ApiError {
    return new ApiError(503, 'container_unavailable', message, { retry_after_ms: retryAfterMs });
  }
  static internal(message: string, details?: unknown): ApiError {
    return new ApiError(500, 'internal_error', message, details);
  }
}

/**
 * Maps an SDK error (from @cloudflare/sandbox) to an ApiError. Route and RPC
 * callers funnel unknown errors through this before responding, so a
 * ContainerUnavailableError becomes a 503 with a retry hint instead of a
 * generic 500, and stale-handle errors surface as a state the caller (or
 * lifecycle.recover) can act on distinctly.
 */
export function fromSdkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const name = (err as { name?: string } | undefined)?.name;
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'ContainerUnavailableError': {
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      return ApiError.unavailable(message, retryAfterMs);
    }
    case 'StaleProcessHandleError':
    case 'StaleTerminalHandleError':
      return ApiError.conflict('session_recovering', 'The container was replaced; recovering the session.');
    case 'OperationInterruptedError':
    case 'RPCTransportError':
      return new ApiError(503, 'sdk_transient', message);
    default:
      return ApiError.internal(message);
  }
}
