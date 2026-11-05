import { describe, expect, test } from 'bun:test'
import { REDACTED, redactString, scrub, serializeError } from '../../../src/utils/telemetry/scrub'

describe('key rule', () => {
  test('redacts sensitive keys case-insensitively, in nested objects and arrays', () => {
    const result = scrub({
      user: { Email: 'victim@example.com', contacts: [{ Phone: '555-0100' }] },
      PASSWORD: 'hunter2',
      routeName: 'kept',
      userId: 'usr_1',
    })

    expect(result).toEqual({
      user: { Email: REDACTED, contacts: [{ Phone: REDACTED }] },
      PASSWORD: REDACTED,
      routeName: 'kept',
      userId: 'usr_1',
    })
  })

  test('ignores underscores and dashes so snake and kebab case keys match', () => {
    const result = scrub({ access_token: 'a', 'set-cookie': 'b', Api_Key: 'c', 'id-token': 'd', session_token: 'e' })

    expect(Object.values(result)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED, REDACTED])
  })

  test('replaces an object value wholesale', () => {
    expect(scrub({ token: { nested: 'value' }, body: ['a', 'b'] })).toEqual({ token: REDACTED, body: REDACTED })
  })

  test('redacts the top-level code unless the event keeps it', () => {
    expect(scrub({ code: 'ABC123', status: 500 })).toEqual({ code: REDACTED, status: 500 })
    expect(scrub({ code: 'INTERNAL_ERROR', status: 500 }, { keep: ['code'] })).toEqual({
      code: 'INTERNAL_ERROR',
      status: 500,
    })
  })
})

describe('value rule', () => {
  test.each([
    ['an email', 'user victim@example.com signed up', 'victim@example.com', '[REDACTED:email]'],
    ['a JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl end', 'eyJhbGciOiJIUzI1NiJ9', '[REDACTED:jwt]'],
    ['a bearer token', 'header Bearer abc.def-ghi done', 'abc.def-ghi', '[REDACTED:bearer]'],
    ['a token in a URL', 'GET /reset?token=RESETTOKEN123&x=1', 'RESETTOKEN123', '[REDACTED:url-secret]'],
    ['an OAuth code and state', '/cb?code=OAUTHCODE&state=OAUTHSTATE', 'OAUTHCODE', '[REDACTED:url-secret]'],
    ['a connection string', 'at mongodb+srv://admin:s3cretPass@host.example.net/db', 's3cretPass', '[REDACTED:dsn]'],
    ['a postgres URL', 'postgres://app:pgPassword@localhost:5432/app', 'pgPassword', '[REDACTED:dsn]'],
  ])('replaces %s in any string', (_label, input, secret, marker) => {
    const result = redactString(input)

    expect(result).not.toContain(secret)
    expect(result).toContain(marker)
  })

  test('replaces all of them in one message', () => {
    const message = 'a@b.com eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln https://x.test/p?token=T0KEN'
    const result = scrub({ err: { message } })

    expect(JSON.stringify(result)).not.toMatch(/a@b\.com|eyJhbGci|T0KEN/)
  })

  test('applies to strings inside arrays and nested objects', () => {
    const result = scrub({ list: ['ok', 'victim@example.com'], deep: { note: 'Bearer secret-value' } })

    expect(JSON.stringify(result)).not.toMatch(/victim@example|secret-value/)
  })
})

describe('exceptions', () => {
  test('keeps err.code and err.name, still scrubs err.message', () => {
    const result = scrub({ err: { name: 'PostgresError', code: '23505', message: 'dup victim@example.com' } })

    expect(result).toEqual({ err: { name: 'PostgresError', code: '23505', message: 'dup [REDACTED:email]' } })
  })

  test('redacts name and code anywhere else', () => {
    const result = scrub({ user: { name: 'Victim Person', code: '1234' }, other: { err: { x: 1 } } })

    expect(result).toEqual({ user: { name: REDACTED, code: REDACTED }, other: { err: { x: 1 } } })
  })

  test('keeps a path named by the event untouched, including secrets inside it', () => {
    const url = 'http://localhost:3000/verify?token=DEVTOKEN'

    expect(scrub({ url }, { keep: ['url'] })).toEqual({ url })
    expect(scrub({ url })).toEqual({ url: REDACTED })
  })
})

describe('limits', () => {
  test('replaces anything deeper than 6 levels', () => {
    const result = scrub({ a: { a: { a: { a: { a: { a: { a: { a: { a: 'deep' } } } } } } } } })
    const level = (path: string[]) => path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], result)

    expect(level(['a', 'a', 'a', 'a', 'a', 'a'])).toBeInstanceOf(Object)
    expect(level(['a', 'a', 'a', 'a', 'a', 'a', 'a'])).toBe('[TRUNCATED]')
  })

  test('keeps the first 100 keys and marks the rest', () => {
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index]))
    const result = scrub(wide)

    expect(Object.keys(result)).toHaveLength(101)
    expect(result['[TRUNCATED]']).toBe(true)
  })

  test('cuts arrays at 100 items', () => {
    const result = scrub({ items: Array.from({ length: 120 }, (_, index) => index) })
    const items = result.items as unknown[]

    expect(items).toHaveLength(101)
    expect(items.at(-1)).toBe('[TRUNCATED]')
  })

  test('cuts strings at 2000 characters', () => {
    const result = scrub({ text: 'x'.repeat(3000) })

    expect(result.text).toBe(`${'x'.repeat(2000)}[TRUNCATED]`)
  })

  test('redacts a secret that straddles the cut instead of leaving half of it', () => {
    const result = scrub({ text: `${'x'.repeat(1990)} Bearer ${'s'.repeat(300)}` })

    expect(String(result.text)).not.toContain('sssss')
  })

  test('terminates on circular references', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop

    expect(() => scrub(loop)).not.toThrow()
  })

  test('returns { scrubFailed: true } instead of throwing', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded')
      },
    }

    expect(scrub(hostile)).toEqual({ scrubFailed: true })
  })
})

describe('value types', () => {
  test('drops undefined and functions, stringifies bigint, formats dates, serializes errors', () => {
    const result = scrub({
      gone: undefined,
      fn: () => 1,
      big: 10n,
      when: new Date('2026-11-03T00:00:00.000Z'),
      broken: new Date('nope'),
      failure: new Error('boom victim@example.com'),
    })

    expect(result).toMatchObject({
      big: '10',
      when: '2026-11-03T00:00:00.000Z',
      broken: null,
      failure: { name: REDACTED, message: 'boom [REDACTED:email]' },
    })
    expect(result).not.toHaveProperty('gone')
    expect(result).not.toHaveProperty('fn')
  })
})

describe('serializeError', () => {
  class PostgresError extends Error {
    override readonly name = 'PostgresError'
    readonly code = '23505'
    readonly constraint = 'user_email_key'
    readonly table = 'user'
    readonly column = 'email'
    readonly detail = 'Key (email)=(victim@example.com) already exists.'
    readonly params = ['victim@example.com']
    readonly query = 'insert into "user" (email) values ($1)'
    readonly keyValue = { email: 'victim@example.com' }
    override readonly cause = new Error('inner victim@example.com')
  }

  test('keeps what identifies the failure and drops what carries data', () => {
    const serialized = serializeError(new PostgresError('duplicate key value violates unique constraint'))

    expect(serialized).toMatchObject({
      name: 'PostgresError',
      code: '23505',
      constraint: 'user_email_key',
      table: 'user',
      column: 'email',
      message: 'duplicate key value violates unique constraint',
    })
    expect(typeof serialized.stack).toBe('string')
    expect(JSON.stringify(serialized)).not.toContain('victim@example.com')
    expect(Object.keys(serialized)).not.toContain('detail')
  })

  test('runs the value patterns on the message and the stack, then cuts the message at 500 characters', () => {
    const serialized = serializeError(new Error(`victim@example.com ${'y'.repeat(900)}`))

    expect(serialized.message).toStartWith('[REDACTED:email] yyy')
    expect(serialized.message).toHaveLength(500)
    expect(serialized.stack).not.toContain('victim@example.com')
  })

  // Shaped like drizzle-orm 0.45's DrizzleQueryError: the name stays `Error`, and the message (and so
  // the stack) embeds the parameter values on a `params:` line.
  class DrizzleQueryError extends Error {
    constructor(
      readonly query: string,
      readonly params: unknown[],
    ) {
      super(`Failed query: ${query}\nparams: ${params.join(',')}`)
    }
  }

  const SESSION_TOKEN = 'k3Xb9sessionTokenValue'
  const PASSWORD_HASH = 'a1b2c3d4e5f6:9f8e7d6c5b4a3f2e1d0c'
  const drizzleError = () =>
    new DrizzleQueryError('select "id" from "session" where "token" = $1 and "hash" = $2', [SESSION_TOKEN, PASSWORD_HASH])

  test('drops the params Drizzle embeds in the message and the stack, keeping the query and the frames', () => {
    const serialized = serializeError(drizzleError())

    expect(serialized.message).toBe(
      'Failed query: select "id" from "session" where "token" = $1 and "hash" = $2\nparams: [REDACTED]',
    )
    expect(serialized.stack).toStartWith(`Error: ${serialized.message}\n`)
    expect(serialized.stack).toContain('scrub.test.ts')
    expect(JSON.stringify(serialized)).not.toContain(SESSION_TOKEN)
    expect(JSON.stringify(serialized)).not.toContain(PASSWORD_HASH)
  })

  test('drops params that span several lines or would fall past the message cut', () => {
    const multiline = serializeError(new DrizzleQueryError('select 1', ['line one\n    at fake (x.ts:1:1)', SESSION_TOKEN]))
    const long = serializeError(new DrizzleQueryError(`select ${'"c", '.repeat(80)}1`, [SESSION_TOKEN]))

    expect(multiline.message).toBe('Failed query: select 1\nparams: [REDACTED]')
    expect(multiline.stack).not.toContain('line one')
    expect(JSON.stringify(multiline)).not.toContain(SESSION_TOKEN)
    expect(JSON.stringify(long)).not.toContain(SESSION_TOKEN)
  })

  test('cuts the stack at the params line when the message is not in it', () => {
    const error = drizzleError()
    error.stack = `Error: rewritten\nparams: ${SESSION_TOKEN}\n    at somewhere (file.ts:1:1)`

    const serialized = serializeError(error)

    expect(serialized.stack).toBe('Error: rewritten\nparams: [REDACTED]')
  })

  test('logs a Drizzle error without its params through scrub', () => {
    const result = scrub({ err: drizzleError() })

    expect(JSON.stringify(result)).toContain('params: [REDACTED]')
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN)
    expect(JSON.stringify(result)).not.toContain(PASSWORD_HASH)
  })

  test('is stable on its own output for a Drizzle error', () => {
    const once = serializeError(drizzleError())

    expect(serializeError(once)).toEqual(once)
  })

  test('accepts non-error values and its own output', () => {
    expect(serializeError('plain victim@example.com')).toEqual({ message: 'plain [REDACTED:email]' })
    const once = serializeError(new PostgresError('x'))

    expect(serializeError(once)).toEqual(once)
  })
})
