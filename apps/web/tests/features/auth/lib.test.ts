import { describe, expect, test } from 'bun:test'
import { ApiError } from '@/lib/api-error'
import {
  accessErrorView,
  AuthError,
  authErrorField,
  authErrorView,
  networkError,
  oauthErrorView,
  parseRetryAfter,
  SESSION_ENDED,
  SIGN_IN_FAILED,
  toAuthError,
  updateUserErrorView,
} from '@/features/auth/lib/errors'
import { authKeys } from '@/features/auth/lib/keys'
import { DEFAULT_REDIRECT, safeRedirect } from '@/features/auth/lib/redirect'
import { toAuthSession } from '@/features/auth/lib/session'
import { emailError, nameError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordError } from '@/features/auth/lib/validation'

describe('safeRedirect', () => {
  test.each([
    ['/access', '/access'],
    ['/posts/42?tab=comments#c1', '/posts/42?tab=comments#c1'],
    ['/a/../access', '/access'],
  ])('keeps the same-origin path %p', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected)
  })

  test.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash that browsers read as a slash', '/\\evil.example'],
    ['a scheme', 'javascript:alert(1)'],
    ['a tab browsers strip', '/\t/evil.example'],
    ['a newline browsers strip', '/\n/evil.example'],
    ['a relative path', 'access'],
    ['an empty string', ''],
    ['a non-string', ['/access']],
    ['undefined', undefined],
    ['a path longer than 2048 characters', `/${'a'.repeat(2048)}`],
    ['the login page (redirect loop)', '/login?redirect=/access'],
    ['the register page', '/register'],
    ['an API path, which the router does not serve', '/api/auth/sign-out'],
    ['a dot segment that normalises to //host', '/a/..//evil.example'],
    ['a current-directory segment that normalises to //host', '/.//evil.example'],
    ['a deeper dot-segment climb to //host', '/a/b/../..//evil.example/x?y#z'],
    ['an encoded dot segment that normalises to //host', '/a/%2e%2e//evil.example'],
    ['an upper-case encoded dot segment', '/a/%2E%2E//evil.example'],
    ['a mixed encoded dot segment', '/a/.%2e//evil.example'],
    ['an encoded current-directory segment', '/%2e//evil.example'],
    ['a dot segment that normalises to the login page', '/a/../login'],
  ])('falls back to / for %s', (_, input) => {
    expect(safeRedirect(input)).toBe(DEFAULT_REDIRECT)
  })

  test('a percent-encoded double slash stays a path on this origin', () => {
    expect(safeRedirect('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example')
  })
})

describe('auth field validators', () => {
  test('accept a well-formed email and a password of the minimum length', () => {
    expect(emailError('alice@example.test')).toBeUndefined()
    expect(emailError('  alice@example.test  ')).toBeUndefined()
    expect(passwordError('a'.repeat(PASSWORD_MIN_LENGTH))).toBeUndefined()
  })

  test('require every field', () => {
    expect(emailError('')).toBe('Enter your email address.')
    expect(emailError('   ')).toBe('Enter your email address.')
    expect(passwordError('')).toBe('Enter your password.')
    expect(nameError('')).toBe('Enter your name.')
  })

  test.each(['alice', 'alice@', 'alice@example', 'a lice@example.test'])('rejects the malformed email %p', (email) => {
    expect(emailError(email)).toContain('valid email')
  })

  test('enforce the password length bounds the API uses', () => {
    expect(passwordError('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('Password must be at least 8 characters.')
    expect(passwordError('a'.repeat(PASSWORD_MAX_LENGTH))).toBeUndefined()
    expect(passwordError('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('Password must be at most 128 characters.')
  })

  test('a name must not be only spaces', () => {
    expect(nameError('   ')).toBe('Enter your name.')
    expect(nameError('Alice')).toBeUndefined()
  })
})

describe('auth error mapping', () => {
  test('every rejected sign-in shows the same generic message, whatever the 401 code', () => {
    const wrongPassword = authErrorView(toAuthError({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }), 'sign-in')
    const otherCode = authErrorView(toAuthError({ status: 401, code: 'SOMETHING_ELSE' }), 'sign-in')

    expect(wrongPassword).toEqual({ code: 'INVALID_EMAIL_OR_PASSWORD', message: SIGN_IN_FAILED })
    expect(otherCode.message).toBe(SIGN_IN_FAILED)
  })

  test('a 429 has no code, so it is mapped on the status, with the wait from X-Retry-After', () => {
    const error = toAuthError({ status: 429, message: 'Too many requests. Please try again later.' }, 60)

    expect(error.code).toBe('RATE_LIMITED')
    expect(authErrorView(error, 'sign-in')).toEqual({ code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 60 seconds.' })
    expect(authErrorView(toAuthError({ status: 429 }), 'sign-up').message).toBe('Too many attempts. Try again in a minute.')
  })

  test('maps the recorded Better Auth codes (auth/README.md §5)', () => {
    expect(authErrorView(toAuthError({ status: 403, code: 'BANNED_USER' }), 'sign-in').message).toContain('banned')
    expect(authErrorView(toAuthError({ status: 422, code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }), 'sign-up').message).toBe(
      'An account with this email already exists. Sign in instead.',
    )
    expect(authErrorView(toAuthError({ status: 404, code: 'PROVIDER_NOT_FOUND' }), 'google').message).toBe(
      'Google sign-in is not configured on this server.',
    )
  })

  test('an unknown code keeps the code and gets a message for the action', () => {
    expect(authErrorView(toAuthError({ status: 500, code: 'INTERNAL_ERROR' }), 'sign-up')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The account could not be created. Try again.',
    })
  })

  test('a network failure never shows the raw error', () => {
    const view = authErrorView(networkError(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:3000')), 'sign-in')

    expect(view.code).toBe('NETWORK_ERROR')
    expect(view.message).not.toContain('ECONNREFUSED')
  })

  test.each([
    [400, 'INVALID_EMAIL', 'email'],
    [422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'email'],
    [400, 'PASSWORD_TOO_SHORT', 'password'],
    [400, 'PASSWORD_TOO_LONG', 'password'],
  ] as const)('a %p %s belongs on the %s field', (status, code, field) => {
    expect(authErrorField(toAuthError({ status, code }))).toBe(field)
  })

  test('form-level errors belong on no field, and a rejected sign-in never does', () => {
    expect(authErrorField(toAuthError({ status: 401, code: 'INVALID_EMAIL' }))).toBeUndefined()
    expect(authErrorField(toAuthError({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }))).toBeUndefined()
    expect(authErrorField(toAuthError({ status: 429 }))).toBeUndefined()
    expect(authErrorField(toAuthError({ status: 400, code: 'VALIDATION_ERROR' }))).toBeUndefined()
    expect(authErrorField(new Error('INVALID_EMAIL'))).toBeUndefined()
  })

  test('a profile save that finds no session says so; other failures keep their code', () => {
    expect(updateUserErrorView(toAuthError({ status: 401, code: 'UNAUTHORIZED' }))).toEqual({ code: 'UNAUTHORIZED', message: SESSION_ENDED })
    expect(updateUserErrorView(toAuthError({ status: 500, code: 'INTERNAL_ERROR' }))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Your profile could not be saved. Try again.',
    })
  })

  test('something that is not an AuthError gets the fallback', () => {
    expect(authErrorView(new Error('boom'), 'sign-out')).toEqual({ code: 'UNKNOWN_ERROR', message: 'Sign-out failed. Try again.' })
  })

  test.each([
    ['60', 60],
    ['0', undefined],
    ['-1', undefined],
    ['soon', undefined],
    [null, undefined],
  ])('parseRetryAfter(%p) → %p', (input, expected) => {
    expect(parseRetryAfter(input)).toBe(expected)
  })

  test('accessErrorView shows the API code of a failed permissions call', () => {
    expect(accessErrorView(new ApiError(500, 'INTERNAL_ERROR', 'Internal server error')).code).toBe('INTERNAL_ERROR')
    expect(accessErrorView(new AuthError(500, 'FAILED_TO_GET_SESSION', 'x')).code).toBe('FAILED_TO_GET_SESSION')
    expect(accessErrorView(new TypeError('fetch failed')).code).toBe('NETWORK_ERROR')
  })
})

describe('oauthErrorView', () => {
  test('a cancelled Google sign-in says no account was created', () => {
    expect(oauthErrorView('access_denied').message).toBe('Google sign-in was cancelled. No account was created.')
  })

  test('a state or PKCE mismatch asks to start again', () => {
    expect(oauthErrorView('state_mismatch').message).toContain('Start again')
  })

  test('an unknown code gets the generic message', () => {
    expect(oauthErrorView('unable_to_create_user')).toEqual({ code: 'unable_to_create_user', message: 'Google sign-in failed. Try again.' })
  })

  test('a code that is not a plain identifier is never echoed back', () => {
    expect(oauthErrorView('<script>alert(1)</script>').code).toBe('oauth_error')
  })
})

describe('session shape', () => {
  test('keeps only what the UI needs: the session token never reaches the cache (or the SSR HTML)', () => {
    const session = toAuthSession({
      user: { id: 'usr_1', email: 'a@b.co', name: 'A', role: 'admin' },
      session: { token: 'secret-token' },
    } as Parameters<typeof toAuthSession>[0])

    expect(session).toEqual({ user: { id: 'usr_1', email: 'a@b.co', name: 'A', image: null } })
    expect(JSON.stringify(session)).not.toContain('secret-token')
  })

  test('permission keys are per user', () => {
    expect(authKeys.permissions('usr_1')).not.toEqual(authKeys.permissions('usr_2'))
    expect(authKeys.permissions('usr_1').slice(0, 1)).toEqual([...authKeys.all])
  })
})
