import { beforeEach, describe, expect, test } from 'bun:test'
import { createAuthLogger } from '../../../src/utils/logger/auth'
import { runWithRequestContext } from '../../../src/utils/logger/context'
import { captureLogger, expectNoDuplicateKeys } from '../../helpers/capture'

// redaction.md §7: "Better Auth's own logger output → goes through the scrubber". Better Auth is
// not installed until TASK-04, so these calls stand in for what it makes: `log(level, message,
// ...args)` with the shape of its `logger` option (verified against its documentation and
// `packages/core/src/env/logger.ts`, where `success` is mapped to `info` before the call).

const capture = captureLogger()
const authLogger = createAuthLogger(capture.logger)

beforeEach(() => capture.clear())

function written(): string {
  // A test that captured nothing would pass for the wrong reason.
  expect(capture.lines().length).toBeGreaterThan(0)
  return capture.output()
}

describe('authLogger', () => {
  test('an email, a token and a cookie in the message or the arguments never appear', () => {
    authLogger.log('error', 'Failed to send a reset link to victim@example.com')
    authLogger.log('error', 'Callback failed', { token: 'SECRETTOKEN', user: { email: 'victim@example.com' } })
    authLogger.log('warn', 'Rejected request', {
      headers: { cookie: 'better-auth.session_token=SECRETCOOKIE', authorization: 'Bearer SECRETBEARER' },
    })
    authLogger.log('error', 'Session lookup failed', 'Bearer SECRETBEARER2', ['victim@example.com'])
    authLogger.log('error', 'Verification failed', new Error('invalid link /verify?token=SECRETLINK for victim@example.com'))

    expect(written()).not.toMatch(/victim@example|SECRET/)
  })

  test('an Error argument keeps its class and code but loses its personal data', () => {
    const failure = Object.assign(new Error('duplicate key for victim@example.com'), {
      name: 'PostgresError',
      code: '23505',
      detail: 'Key (email)=(victim@example.com) already exists.',
    })

    authLogger.log('error', 'Failed to create user', failure)

    const [line] = capture.lines()
    expect(line).toMatchObject({
      err: { name: 'PostgresError', code: '23505', message: 'duplicate key for [REDACTED:email]' },
    })
    expect(line?.err).not.toHaveProperty('detail')
    expect(line).not.toHaveProperty('args')
    expect(written()).not.toContain('victim@example.com')
  })

  test('other arguments next to the Error stay in `args`, scrubbed', () => {
    authLogger.log('error', 'Failed to link account', { provider: 'google', email: 'victim@example.com' }, new Error('boom'))

    const [line] = capture.lines()
    expect(line).toMatchObject({ err: { message: 'boom' }, args: [{ provider: 'google', email: '[REDACTED]' }] })
    expect(written()).not.toContain('victim@example.com')
  })

  test('every line carries module "auth" and the mandatory fields, with no duplicate keys', () => {
    authLogger.log('warn', 'Rate limit reached', { path: '/sign-in/email' })

    expect(capture.lines()[0]).toMatchObject({
      level: 'warn',
      kind: 'app',
      event: 'log',
      service: 'api',
      env: 'test',
      module: 'auth',
      msg: 'Rate limit reached',
    })
    expect(capture.lines()[0]?.time).toBeString()
    expectNoDuplicateKeys(capture.output())
  })

  test('module stays "auth" inside a request that another module owns, and the request ID is kept', () => {
    runWithRequestContext('req-auth-1', () => authLogger.log('error', 'Hook failed'))

    expect(capture.lines()[0]).toMatchObject({ module: 'auth', requestId: 'req-auth-1' })
  })

  test('each Better Auth level is written at the matching pino level', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) authLogger.log(level, `a ${level} line`)

    expect(capture.lines().map((line) => line.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  test('a call without extra arguments writes no `args` field', () => {
    authLogger.log('info', 'Ready')

    expect(capture.lines()[0]).not.toHaveProperty('args')
  })
})
