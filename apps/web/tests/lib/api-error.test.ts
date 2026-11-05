import { describe, expect, test } from 'bun:test'
import { ApiError, callAuthClient, fromAuthClient, NETWORK_ERROR, networkError, toApiError, unwrap } from '@/lib/api-error'
import { shouldRetry } from '@/lib/query-client'
import { authFailed, apiFailed, ok, rejectWith } from '../helpers/api-results'

describe('unwrap (Eden)', () => {
  test('returns data on success', async () => {
    expect(await unwrap(Promise.resolve(ok({ status: 'ok' })))).toEqual({ status: 'ok' })
  })

  test('throws an ApiError carrying status, code, message and details', async () => {
    const details = { fields: [{ path: '/title', rule: 'minLength' }] }
    const thrown = await unwrap(Promise.resolve(apiFailed(400, { code: 'VALIDATION_ERROR', message: 'Invalid request', details }))).catch(
      (error: unknown) => error,
    )
    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request', details, network: false, source: 'api' })
  })

  test('a fetch that throws becomes a network ApiError, keeping the cause', async () => {
    const cause = new TypeError('fetch failed')
    const thrown = await unwrap(Promise.reject(cause)).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({ status: 0, code: NETWORK_ERROR, network: true, source: 'api' })
    expect((thrown as ApiError).cause).toBe(cause)
  })
})

describe('toApiError', () => {
  test('falls back to INTERNAL_ERROR when the body is not our error format', () => {
    expect(toApiError(502, 'Bad Gateway')).toMatchObject({ status: 502, code: 'INTERNAL_ERROR', message: 'Internal server error' })
    expect(toApiError(500, null)).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(toApiError(500, { code: 42, message: 'x' })).toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})

describe('fromAuthClient (Better Auth)', () => {
  test('keeps status and code, UNKNOWN_ERROR when none was sent', () => {
    expect(fromAuthClient({ status: 400, code: 'LAST_SUPER_ADMIN', message: 'x' })).toMatchObject({
      status: 400,
      code: 'LAST_SUPER_ADMIN',
      message: 'x',
      source: 'auth',
      network: false,
    })
    expect(fromAuthClient({ status: 401 })).toMatchObject({ status: 401, code: 'UNKNOWN_ERROR' })
    expect(fromAuthClient({ status: 502 })).toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' })
  })

  test('a 429 is RATE_LIMITED with the wait it was given', () => {
    expect(fromAuthClient({ status: 429, message: 'Too many requests.' }, 30)).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 30 })
  })
})

describe('callAuthClient', () => {
  test('returns the success body', async () => {
    expect(await callAuthClient(async () => ok({ status: true }))).toEqual({ status: true })
  })

  test('throws the HTTP error with X-Retry-After read through fetchOptions', async () => {
    const send = rejectWith(429, { message: 'Too many requests.' }, { 'x-retry-after': '42' })
    await expect(callAuthClient((fetchOptions) => send({ fetchOptions }))).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'RATE_LIMITED',
      retryAfter: 42,
      source: 'auth',
    })
  })

  test('a fetch that throws is a network ApiError from the auth surface', async () => {
    const thrown = await callAuthClient(async () => {
      throw new TypeError('fetch failed')
    }).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ name: 'ApiError', status: 0, code: NETWORK_ERROR, network: true, source: 'auth' })
  })

  test('an error result without a code still becomes an ApiError', async () => {
    await expect(callAuthClient(async () => authFailed(500))).rejects.toMatchObject({ status: 500, code: 'UNKNOWN_ERROR' })
  })
})

describe('shouldRetry', () => {
  test('never retries an HTTP answer below 500', () => {
    expect(shouldRetry(0, new ApiError(401, 'UNAUTHORIZED', 'Unauthorized'))).toBe(false)
    expect(shouldRetry(0, new ApiError(499, 'X', 'x'))).toBe(false)
    // A refused redirect (`redirect: 'manual'`) reaches the browser as status 0, but it is an answer.
    expect(shouldRetry(0, new ApiError(0, 'INTERNAL_ERROR', 'x'))).toBe(false)
  })

  test('retries a 5xx or network failure once', () => {
    expect(shouldRetry(0, new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(true)
    expect(shouldRetry(0, networkError(new TypeError('fetch failed')))).toBe(true)
    expect(shouldRetry(1, networkError(new TypeError('fetch failed'), 'auth'))).toBe(false)
    expect(shouldRetry(0, new TypeError('fetch failed'))).toBe(true)
  })
})
