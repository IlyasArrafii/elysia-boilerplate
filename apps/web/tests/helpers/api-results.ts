// What the two API clients resolve to, for every feature's `api-mock.ts`. Both answer `{ data, error }` and reject only
// when `fetch` throws (use `mockRejectedValue(new TypeError('fetch failed'))` for that); `src/lib/api-error.ts` turns
// each into the app's one `ApiError`.

// Better Auth client errors: `{ status, statusText, code?, message? }`.
export interface AuthClientErrorBody {
  status: number
  statusText: string
  code?: string
  message?: string
}

type FetchOptions = { onError?: (context: { response: Response }) => void }

export const ok = <Data>(data: Data) => ({ data, error: null })

// Eden's failure: the HTTP status and the body as sent (`{ code, message, details? }` from an API module).
export const apiFailed = (status: number, value: unknown) => ({ data: null, error: { status, value } })

// The Better Auth client's failure.
export const authFailed = (status: number, body: Partial<Omit<AuthClientErrorBody, 'status'>> = {}) => ({
  data: null,
  error: { status, statusText: '', ...body },
})

// A rejected Better Auth call as better-fetch reports it, after running the caller's `onError` with the response
// (where `X-Retry-After` is read).
export function rejectWith(status: number, body: Partial<Omit<AuthClientErrorBody, 'status'>>, headers: Record<string, string> = {}) {
  return async (call: { fetchOptions?: FetchOptions } = {}) => {
    call.fetchOptions?.onError?.({ response: new Response(null, { status, headers }) })
    return authFailed(status, body)
  }
}
