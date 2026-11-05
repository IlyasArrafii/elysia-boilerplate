// The one error type for every failed API call, whichever client made it (apps/web R12): Eden for the API modules,
// the Better Auth client for `/api/auth/*`, and `fetch` throwing before any answer. Hooks throw it, TanStack Query
// retries by it (`shouldRetry`), the auth feature reacts to its 401/403 (`installAuthFailureReactions`), and each
// feature maps its `code` to a message.

// Local codes for failures the API sends no code for.
export const NETWORK_ERROR = 'NETWORK_ERROR'
export const RATE_LIMITED = 'RATE_LIMITED'
export const UNKNOWN_ERROR = 'UNKNOWN_ERROR'

// Which surface answered. Their codes differ: an API module uses DEC-017 codes (API.md §2), Better Auth its own
// (auth/README.md §5), so features that show both tell them apart by this.
export type ApiErrorSource = 'api' | 'auth'

export interface ApiErrorOptions {
  details?: unknown
  // No HTTP answer at all (offline, API down): `status` is 0 and a retry may succeed.
  network?: boolean
  // Seconds from `X-Retry-After` on a 429.
  retryAfter?: number
  source?: ApiErrorSource
  cause?: unknown
}

export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly details: unknown
  readonly network: boolean
  readonly retryAfter: number | undefined
  readonly source: ApiErrorSource

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    { details, network = false, retryAfter, source = 'api', cause }: ApiErrorOptions = {},
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.details = details
    this.network = network
    this.retryAfter = retryAfter
    this.source = source
  }
}

// `fetch` itself failed: there is no response to read a status or code from.
export function networkError(cause: unknown, source: ApiErrorSource = 'api'): ApiError {
  return new ApiError(0, NETWORK_ERROR, 'The API could not be reached.', { network: true, source, cause })
}

// --- Eden (API modules) ---

// Error body of our API modules (DEC-017, API.md §2).
interface ApiErrorBody {
  code: string
  message: string
  details?: unknown
}

// Used when the response is not our error format, e.g. the dev proxy answering for an API that is down.
const FALLBACK_CODE = 'INTERNAL_ERROR'
const FALLBACK_MESSAGE = 'Internal server error'

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Record<string, unknown>
  return typeof body.code === 'string' && typeof body.message === 'string'
}

export function toApiError(status: number, value: unknown): ApiError {
  if (!isErrorBody(value)) return new ApiError(status, FALLBACK_CODE, FALLBACK_MESSAGE)
  return new ApiError(status, value.code, value.message, { details: value.details })
}

type EdenResult<T> = { data: T; error: null } | { data: null; error: { status: number; value: unknown } }

// Eden resolves to `{ data, error }` for HTTP errors and rejects only when `fetch` throws. TanStack Query needs a
// thrown error carrying the status and code that pages show: `unwrap(api.posts.get())`.
export async function unwrap<T>(call: Promise<EdenResult<T>>): Promise<T> {
  let result: EdenResult<T>
  try {
    result = await call
  } catch (cause) {
    throw networkError(cause, 'api')
  }
  if (result.error) throw toApiError(result.error.status, result.error.value)
  return result.data
}

// --- Better Auth client (`/api/auth/*`) ---

// Better Auth client errors: `{ status, statusText, code?, message? }`.
export interface AuthClientError {
  status: number
  code?: string
  message?: string
}

export function fromAuthClient(error: AuthClientError, retryAfter?: number): ApiError {
  // A 429 carries no code, only `{ message }` and the header (auth/README.md §5). Any other failure without a code is
  // UNKNOWN_ERROR; a feature that labels those by status (admin) does so in its own view.
  const code = error.status === 429 ? RATE_LIMITED : (error.code ?? UNKNOWN_ERROR)
  return new ApiError(error.status, code, error.message ?? code, { retryAfter, source: 'auth' })
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined
}

// What a Better Auth client method accepts as `fetchOptions`: the hook that reads `X-Retry-After` off a failure.
export interface AuthFetchOptions {
  onError: (context: { response: Response }) => void
}

type AuthClientResult<Data> = { data: Data | null; error: AuthClientError | null }

// One Better Auth client call, given the `fetchOptions` to pass on (a caller that ignores them loses `retryAfter`).
export type AuthClientCall<Data> = (fetchOptions: AuthFetchOptions) => Promise<AuthClientResult<Data>>

// Runs one Better Auth client call and throws its failure as an ApiError: `fetch` throwing means no response at all,
// an HTTP error comes back as `result.error`. Pass `fetchOptions` on to the client method to keep `retryAfter`.
// Resolves to the success body, which the client types as nullable.
export async function callAuthClient<Data>(send: AuthClientCall<Data>): Promise<Data | null> {
  let retryAfter: number | undefined
  let result: AuthClientResult<Data>
  try {
    result = await send({
      onError: ({ response }) => {
        retryAfter = parseRetryAfter(response.headers.get('x-retry-after'))
      },
    })
  } catch (cause) {
    throw networkError(cause, 'auth')
  }
  if (result.error) throw fromAuthClient(result.error, retryAfter)
  return result.data
}
