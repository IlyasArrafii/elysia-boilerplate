import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createAuth } from '@repo/auth'
import { env } from '../../../src/env'
import { auth } from '../../../src/utils/auth'
import { ac, roles } from '../../../src/utils/auth/access'
import { DEFAULT_ROLE } from '../../../src/utils/auth/roles'
import { createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createMemoryStore } from '../../../src/utils/cache/store'
import { db } from '../../../src/utils/db'
import { authLogger, createAuthLogger } from '../../../src/utils/logger/auth'
import { captureLogger } from '../../helpers/capture'
import { PASSWORD, prepareTestDatabase, uniqueEmail, uniqueIp, WEB_ORIGIN } from './setup'

const ready = await prepareTestDatabase()

let spy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

describe("Better Auth's logger", () => {
  // The installed 1.7.15 type is `log(level: 'debug' | 'info' | 'warn' | 'error', message, ...args)`,
  // the shape `authLogger` was written against in TASK-12.
  test('the app instance hands every Better Auth log call to authLogger', () => {
    spy = spyOn(authLogger, 'log').mockImplementation(() => {})
    const error = new Error('boom')

    auth.options.logger?.log?.('warn', 'Something for victim@example.com', error)

    expect(spy).toHaveBeenCalledWith('warn', 'Something for victim@example.com', error)
  })

  test('is off when LOG_LEVEL is silent (the test default) and on otherwise', () => {
    expect(env.LOG_LEVEL).toBe('silent')
    expect(auth.options.logger).toMatchObject({ disabled: true })
  })
})

describe.skipIf(!ready)("Better Auth's own log output, through the scrubber (needs the test PostgreSQL)", () => {
  test('a duplicate sign-up logs the attempt with the email redacted, tagged module auth', async () => {
    const captured = captureLogger()
    const logged = createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      trustedOrigins: [env.WEB_URL],
      trustedProxies: [],
      secondaryStorage: createSecondaryStorage(createMemoryStore()),
      ac,
      roles,
      defaultRole: DEFAULT_ROLE,
      logger: { level: 'debug', log: createAuthLogger(captured.logger).log },
    })
    const email = uniqueEmail()
    const signUp = () =>
      logged.handler(
        new Request('http://localhost/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-forwarded-for': uniqueIp() },
          body: JSON.stringify({ email, password: PASSWORD, name: 'Logged User' }),
        }),
      )

    expect((await signUp()).status).toBe(200)
    await signUp()

    // Better Auth 1.7.15 writes `Sign-up attempt for existing email: ${email}` at info.
    const attempt = captured.lines().find((line) => String(line.msg).startsWith('Sign-up attempt for existing email'))
    expect(attempt).toMatchObject({ module: 'auth', level: 'info', msg: 'Sign-up attempt for existing email: [REDACTED:email]' })
    expect(captured.output()).not.toContain(email)
    expect(captured.output()).not.toContain(PASSWORD)
  })
})
