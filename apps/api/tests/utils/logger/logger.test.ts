import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../../src/utils/logger'
import { getRequestContext, runWithRequestContext } from '../../../src/utils/logger/context'
import { captureLogger, expectNoDuplicateKeys, topLevelKeys } from '../../helpers/capture'

describe('createLogger', () => {
  test('writes JSON lines with the base fields and the level as a word', () => {
    const capture = captureLogger()
    capture.logger.info('hello')

    const [line] = capture.lines()
    expect(line).toMatchObject({
      level: 'info',
      kind: 'app',
      event: 'log',
      service: 'api',
      env: 'test',
      module: 'core',
      msg: 'hello',
    })
    expect(new Date(String(line?.time)).toISOString()).toBe(String(line?.time))
  })

  test('tags plain lines written inside a request with its module, request ID and user', () => {
    const capture = captureLogger()

    runWithRequestContext('req-42', () => {
      const context = getRequestContext()
      if (context) Object.assign(context, { module: 'posts', userId: 'usr_7' })
      capture.logger.debug('inside')
    })
    capture.logger.debug('outside')

    const [inside, outside] = capture.lines()
    expect(inside).toMatchObject({ module: 'posts', requestId: 'req-42', userId: 'usr_7' })
    expect(outside).toMatchObject({ module: 'core' })
    expect(outside).not.toHaveProperty('requestId')
  })

  test('lets the fields of a call win over the defaults without repeating a key', () => {
    const capture = captureLogger()
    capture.logger.info({ kind: 'http', event: 'http.request', module: 'posts', time: '2026-01-01T00:00:00.000Z' })

    expect(capture.lines()[0]).toMatchObject({ kind: 'http', event: 'http.request', module: 'posts', time: '2026-01-01T00:00:00.000Z' })
    expectNoDuplicateKeys(capture.output())
  })

  test('overriding service and env in a call does not repeat them either', () => {
    const capture = captureLogger()
    capture.logger.info({ service: 'api', env: 'test' })

    expectNoDuplicateKeys(capture.output())
    expect(topLevelKeys(capture.output().trim()).filter((key) => key === 'service' || key === 'env')).toHaveLength(2)
  })

  test('drops lines below the configured level', () => {
    const chunks: string[] = []
    const logger = createLogger({ level: 'info', nodeEnv: 'production', stream: { write: (chunk) => void chunks.push(chunk) } })

    logger.debug('quiet')
    logger.info('loud')

    expect(chunks).toHaveLength(1)
  })
})

describe('pino redact (layer 3)', () => {
  test('censors authorization and cookie headers and the listed secret fields', () => {
    const capture = captureLogger()
    capture.logger.info({
      req: { headers: { authorization: 'Bearer SECRETBEARER', cookie: 'app.session=SECRETCOOKIE', accept: 'json' } },
      res: { headers: { 'set-cookie': 'app.session=SECRETSET' } },
      user: { password: 'SECRETPASS', token: 'SECRETTOKEN', secret: 'SECRETSECRET', email: 'secret@example.com' },
      auth: { accessToken: 'SECRETACCESS', refreshToken: 'SECRETREFRESH', idToken: 'SECRETID' },
    })

    expect(capture.output()).not.toContain('SECRET')
    expect(capture.output()).not.toContain('secret@example.com')
    expect(capture.lines()[0]).toMatchObject({ req: { headers: { accept: 'json' } } })
  })

  // `*.key` matches one level down only, so a field passed at the top of the call needs its own path.
  test('censors the listed fields at the top level of the call', () => {
    const capture = captureLogger()
    capture.logger.info({ password: 'SECRETPASS', token: 'SECRETTOKEN', secret: 'SECRETSECRET', email: 'secret@example.com', attempt: 2 })

    expect(capture.output()).not.toContain('SECRET')
    expect(capture.output()).not.toContain('secret@example.com')
    expect(capture.lines()[0]).toMatchObject({ password: '[REDACTED]', email: '[REDACTED]', attempt: 2 })
  })

  test('censors the snake_case and session token spellings Better Auth and OAuth use', () => {
    const capture = captureLogger()
    capture.logger.info({
      access_token: 'SECRETA',
      account: { access_token: 'SECRETB', refresh_token: 'SECRETC', id_token: 'SECRETD', providerId: 'google' },
      session: { sessionToken: 'SECRETE', session_token: 'SECRETF' },
      config: { apiKey: 'SECRETG', api_key: 'SECRETH' },
    })

    expect(capture.output()).not.toContain('SECRET')
    expect(capture.lines()[0]).toMatchObject({ account: { providerId: 'google' } })
  })

  test('censors auth headers under any parent and as a bare header object', () => {
    const capture = captureLogger()
    capture.logger.info({
      request: { headers: { authorization: 'Bearer SECRET1', cookie: 'a=SECRET2', 'set-cookie': 'a=SECRET3', accept: 'json' } },
      headers: { authorization: 'Basic SECRET4', 'set-cookie': 'a=SECRET5' },
    })

    expect(capture.output()).not.toContain('SECRET')
    expect(capture.lines()[0]).toMatchObject({ request: { headers: { accept: 'json' } } })
  })

  test('keeps the fields events rely on: err.name, a kept code and the dev link url', () => {
    const capture = captureLogger()
    capture.logger.info({ event: 'http.error', code: 'NOT_FOUND', err: { name: 'NotFoundError' }, url: 'http://localhost/reset' })

    expect(capture.lines()[0]).toMatchObject({ code: 'NOT_FOUND', err: { name: 'NotFoundError' }, url: 'http://localhost/reset' })
  })

  test('serializes `err` without the data a database error carries', () => {
    const capture = captureLogger()
    const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'PostgresError',
      code: '23505',
      constraint: 'user_email_key',
      detail: 'Key (email)=(victim@example.com) already exists.',
      params: ['victim@example.com'],
    })
    capture.logger.error({ err: error })

    const [line] = capture.lines()
    expect(line).toMatchObject({ err: { name: 'PostgresError', code: '23505', constraint: 'user_email_key' } })
    expect(capture.output()).not.toContain('victim@example.com')
  })
})

describe('messages (layer 3)', () => {
  const email = 'victim@example.com'

  test('scrubs a message string', () => {
    const capture = captureLogger()
    capture.logger.info(`user ${email} signed in`)

    expect(capture.output()).not.toContain(email)
    expect(capture.lines()[0]).toMatchObject({ msg: 'user [REDACTED:email] signed in' })
  })

  test('scrubs a message given next to an object', () => {
    const capture = captureLogger()
    capture.logger.info({ attempt: 3 }, `retry for ${email}`)

    expect(capture.output()).not.toContain(email)
    expect(capture.lines()[0]).toMatchObject({ attempt: 3, msg: 'retry for [REDACTED:email]' })
  })

  test('scrubs the message pino takes from an Error passed on its own', () => {
    const capture = captureLogger()
    capture.logger.error(new Error(`failed for ${email}`))

    expect(capture.output()).not.toContain(email)
    expect(capture.lines()[0]).toMatchObject({ msg: 'failed for [REDACTED:email]', err: { message: 'failed for [REDACTED:email]' } })
  })

  test('scrubs the message pino takes from { err }', () => {
    const capture = captureLogger()
    capture.logger.error({ err: new Error(`failed for ${email}`) })

    expect(capture.output()).not.toContain(email)
    expect(capture.lines()[0]).toMatchObject({ msg: 'failed for [REDACTED:email]' })
  })

  test('keeps a message written next to an Error', () => {
    const capture = captureLogger()
    capture.logger.error(new Error(`failed for ${email}`), 'could not save')

    expect(capture.output()).not.toContain(email)
    expect(capture.lines()[0]).toMatchObject({ msg: 'could not save' })
  })

  test('adds no message to a call that has none, and keeps format arguments working', () => {
    const capture = captureLogger()
    capture.logger.info({ attempt: 1 })
    capture.logger.info('hello %s', 'world')

    const [bare, formatted] = capture.lines()
    expect(bare).not.toHaveProperty('msg')
    expect(formatted).toMatchObject({ msg: 'hello world' })
  })
})
