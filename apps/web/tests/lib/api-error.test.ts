import { describe, expect, test } from 'bun:test'
import { ApiError, toApiError, unwrap } from '@/lib/api-error'
import { shouldRetry } from '@/lib/query-client'

describe('unwrap', () => {
  test('returns data on success', () => {
    expect(unwrap({ data: { status: 'ok' }, error: null })).toEqual({ status: 'ok' })
  })

  test('throws an ApiError carrying status, code, message and details', () => {
    const details = { fields: [{ path: '/title', rule: 'minLength' }] }
    const value = { code: 'VALIDATION_ERROR', message: 'Invalid request', details }
    const thrown = (() => {
      try {
        unwrap({ data: null, error: { status: 400, value } })
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request', details })
  })
})

describe('toApiError', () => {
  test('falls back to INTERNAL_ERROR when the body is not our error format', () => {
    expect(toApiError(502, 'Bad Gateway')).toMatchObject({ status: 502, code: 'INTERNAL_ERROR', message: 'Internal server error' })
    expect(toApiError(500, null)).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(toApiError(500, { code: 42, message: 'x' })).toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})

describe('shouldRetry', () => {
  test('never retries a 4xx', () => {
    expect(shouldRetry(0, new ApiError(401, 'UNAUTHORIZED', 'Unauthorized'))).toBe(false)
    expect(shouldRetry(0, new ApiError(499, 'X', 'x'))).toBe(false)
  })

  test('retries a 5xx or network failure once', () => {
    expect(shouldRetry(0, new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(true)
    expect(shouldRetry(0, new TypeError('fetch failed'))).toBe(true)
    expect(shouldRetry(1, new TypeError('fetch failed'))).toBe(false)
  })
})
