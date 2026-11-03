// Error body of our API modules (DEC-017, API.md §2). `/api/auth/*` uses Better Auth's format instead.
interface ApiErrorBody {
  code: string
  message: string
  details?: unknown
}

// Used when the response is not our error format, e.g. the dev proxy answering for an API that is down.
const FALLBACK_CODE = 'INTERNAL_ERROR'
const FALLBACK_MESSAGE = 'Internal server error'

export class ApiError extends Error {
  override readonly name = 'ApiError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Record<string, unknown>
  return typeof body.code === 'string' && typeof body.message === 'string'
}

export function toApiError(status: number, value: unknown): ApiError {
  if (!isErrorBody(value)) return new ApiError(status, FALLBACK_CODE, FALLBACK_MESSAGE)
  return new ApiError(status, value.code, value.message, value.details)
}

// Eden resolves to `{ data, error }` and never throws for HTTP errors. TanStack Query needs a thrown error,
// carrying the status and code that pages show (apps/web R12).
export function unwrap<T>(result: { data: T; error: null } | { data: null; error: { status: number; value: unknown } }): T {
  if (result.error) throw toApiError(result.error.status, result.error.value)
  return result.data
}
