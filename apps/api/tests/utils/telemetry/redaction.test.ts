import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { telemetry } from '../../../src/utils/telemetry'
import { createLogSink } from '../../../src/utils/telemetry/sinks/log'
import { jsonPost, memory } from '../../helpers/app'
import { captureLogger } from '../../helpers/capture'
import { probeRequest } from '../../helpers/probe'

// redaction.md §7. Each test sends the sensitive value through the real request path and
// asserts it is absent from what the memory sink holds and from what pino would print.
// Cases that need Better Auth, PostgreSQL or MongoDB use stand-ins that produce the same shapes.

const capture = captureLogger()
let removeCaptureSink: () => void = () => {}

beforeAll(() => {
  removeCaptureSink = telemetry.addSink(createLogSink(capture.logger))
})
afterAll(() => removeCaptureSink())
beforeEach(() => {
  memory.clear()
  capture.clear()
})

function everythingWritten(): string {
  // A test that captured nothing would pass for the wrong reason.
  expect(memory.lines.length).toBeGreaterThan(0)
  expect(capture.lines().length).toBeGreaterThan(0)
  return `${capture.output()}\n${JSON.stringify(memory.lines)}`
}

describe('headers', () => {
  test('Cookie and Authorization values never appear, on success, unexpected error and unknown route', async () => {
    const headers = {
      Cookie: 'app.session=SECRETCOOKIE; __Secure-app.session=SECRETSECURECOOKIE',
      Authorization: 'Bearer SECRETBEARER',
      'X-Api-Key': 'SECRETAPIKEY',
    }

    for (const path of ['/api/probe/ok', '/api/probe/boom', '/api/probe/missing', '/api/nowhere']) {
      await probeRequest(path, { headers })
    }

    expect(everythingWritten()).not.toMatch(/SECRET/)
  })
})

describe('request bodies', () => {
  const credentials = { email: 'victim@example.com', password: 'hunter2-secret' }

  test('sign-in style body: password and email never appear on success', async () => {
    const response = await probeRequest(...jsonPost('/api/probe/credentials', credentials))

    expect(response.status).toBe(200)
    expect(everythingWritten()).not.toMatch(/hunter2|victim@example/)
  })

  test('password and email never appear when validation fails', async () => {
    const response = await probeRequest(...jsonPost('/api/probe/credentials', { email: 'victim@example', password: 'hunter2' }))

    expect(response.status).toBe(400)
    expect(await response.text()).not.toMatch(/hunter2|victim@example/)
    expect(everythingWritten()).not.toMatch(/hunter2|victim@example/)
    expect(memory.find('http.error')[0]?.fields).toBeArray()
  })

  test('an email that a failing handler puts in its error message is replaced', async () => {
    await probeRequest(...jsonPost('/api/probe/credentials-fail', credentials))

    expect(everythingWritten()).not.toMatch(/hunter2|victim@example/)
    expect(memory.find('http.error')[0]).toMatchObject({ err: { message: 'could not create [REDACTED:email]' } })
  })

  test('a malformed body is not echoed by the parser', async () => {
    await probeRequest('/api/probe/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"victim@example.com","password":"hunter2-secret',
    })

    expect(everythingWritten()).not.toMatch(/hunter2|victim@example/)
  })
})

describe('OAuth callback', () => {
  test('code and state never appear, and route is the pattern', async () => {
    await probeRequest('/api/probe/callback?code=OAUTHCODE&state=OAUTHSTATE')

    expect(everythingWritten()).not.toMatch(/OAUTHCODE|OAUTHSTATE/)
    expect(memory.find('http.request')[0]).toMatchObject({ route: '/api/probe/callback', status: 500 })
    expect(memory.find('http.error')[0]).toMatchObject({
      err: { message: expect.stringContaining('[REDACTED:url-secret]') },
    })
  })
})

describe('database errors', () => {
  test('a Postgres unique violation on an email column logs the constraint but never the email', async () => {
    await probeRequest('/api/probe/postgres')

    expect(everythingWritten()).not.toContain('victim@example.com')
    expect(memory.find('http.error')[0]).toMatchObject({
      err: { name: 'PostgresError', code: '23505', constraint: 'user_email_key', table: 'user', column: 'email' },
    })
    expect(memory.find('http.error')[0]?.err).not.toHaveProperty('detail')
    expect(memory.find('http.error')[0]?.err).not.toHaveProperty('params')
  })

  test('a MongoDB driver error with a connection string loses its credentials', async () => {
    await probeRequest('/api/probe/mongo')

    const written = everythingWritten()
    expect(written).not.toMatch(/s3cretPass|admin:/)
    expect(written).toContain('[REDACTED:dsn]')
  })
})

describe('error messages', () => {
  test('an email, a JWT and a ?token= URL in err.message are all replaced', async () => {
    await probeRequest('/api/probe/leaky-message')

    const written = everythingWritten()
    expect(written).not.toMatch(/victim@example|eyJhbGci|RESETTOKEN123/)
    expect(memory.find('http.error')[0]?.err).toMatchObject({
      message: expect.stringMatching(/\[REDACTED:email\].*\[REDACTED:jwt\].*\[REDACTED:url-secret\]/),
    })
  })

  test('the stack is scrubbed as well', async () => {
    await probeRequest('/api/probe/leaky-message')

    const stack = String((memory.find('http.error')[0]?.err as { stack?: string }).stack)
    expect(stack).not.toMatch(/victim@example|eyJhbGci|RESETTOKEN123/)
  })
})

describe('direct emit', () => {
  test('a nested { user: { email } } becomes [REDACTED] before every sink', () => {
    const payload = { method: 'GET', route: '/api/x', status: 200, durationMs: 1, user: { email: 'victim@example.com' } }

    telemetry.emit('http.request', payload)

    expect(memory.lines[0]).toMatchObject({ user: { email: '[REDACTED]' } })
    expect(capture.lines()[0]).toMatchObject({ user: { email: '[REDACTED]' } })
    expect(everythingWritten()).not.toContain('victim@example.com')
  })
})
