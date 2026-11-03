import { beforeEach, describe, expect, test } from 'bun:test'
import { jsonPost, memory } from '../../helpers/app'
import { probeRequest } from '../../helpers/probe'

beforeEach(() => memory.clear())

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('request ID', () => {
  test('is generated when the caller sends none, and returned in the header', async () => {
    const response = await probeRequest('/api/probe/ok')

    expect(response.headers.get('x-request-id')).toMatch(UUID)
  })

  test('reuses a valid incoming ID', async () => {
    const response = await probeRequest('/api/probe/ok', { headers: { 'x-request-id': 'trace_ABC-123' } })

    expect(response.headers.get('x-request-id')).toBe('trace_ABC-123')
    expect(memory.find('http.request')[0]?.requestId).toBe('trace_ABC-123')
  })

  test.each([
    ['has a space', 'bad id'],
    ['has a symbol', 'id;drop'],
    ['is 65 characters', 'a'.repeat(65)],
    ['is empty', ''],
  ])('replaces an incoming ID that %s', async (_label, incoming) => {
    const response = await probeRequest('/api/probe/ok', { headers: { 'x-request-id': incoming } })

    expect(response.headers.get('x-request-id')).toMatch(UUID)
  })

  test('accepts a 64 character ID', async () => {
    const id = 'a'.repeat(64)
    const response = await probeRequest('/api/probe/ok', { headers: { 'x-request-id': id } })

    expect(response.headers.get('x-request-id')).toBe(id)
  })

  test.each([
    ['a success', '/api/probe/ok'],
    ['an unknown route', '/api/missing-route'],
    ['an unexpected error', '/api/probe/boom'],
    ['a module error', '/api/probe/missing'],
    ['a raw Response', '/api/probe/raw'],
  ])('is on the response of %s', async (_label, path) => {
    const response = await probeRequest(path)

    expect(response.headers.get('x-request-id')).toMatch(UUID)
  })
})

describe('http.request', () => {
  test.each([
    ['a success', '/api/probe/ok'],
    ['an unknown route', '/api/missing-route'],
    ['an unexpected error', '/api/probe/boom'],
    ['a module error', '/api/probe/missing'],
    ['a raw Response', '/api/probe/raw'],
    ['a validation failure', '/api/probe/credentials'],
  ])('is emitted exactly once for %s, with the ID of the response', async (_label, path) => {
    const response = await probeRequest(path)

    const lines = memory.find('http.request')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.requestId).toBe(String(response.headers.get('x-request-id')))
  })

  test('has the base fields and only the documented payload', async () => {
    await probeRequest('/api/probe/ok', { headers: { 'user-agent': 'secret-agent', cookie: 'app.session=SECRETCOOKIE' } })

    const [line] = memory.find('http.request')
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['durationMs', 'env', 'event', 'kind', 'level', 'method', 'module', 'requestId', 'route', 'service', 'status', 'time'].sort(),
    )
    expect(line).toMatchObject({ kind: 'http', level: 'info', method: 'GET', route: '/api/probe/ok', status: 200, module: 'probe' })
    expect(typeof line?.durationMs).toBe('number')
    expect(Number(line?.durationMs)).toBeGreaterThanOrEqual(0)
  })

  test('logs the route pattern, never the path or the query string', async () => {
    await probeRequest('/api/probe/items/user-4711?token=SECRETTOKEN&email=victim@example.com')

    const [line] = memory.find('http.request')
    expect(line?.route).toBe('/api/probe/items/:id')
    expect(JSON.stringify(memory.lines)).not.toMatch(/4711|SECRETTOKEN|victim/)
  })

  test('uses a fixed label for a route that matched nothing', async () => {
    await probeRequest('/api/oauth/callback?code=SECRETCODE&state=SECRETSTATE')

    expect(memory.find('http.request')[0]?.route).toBe('[unmatched]')
    expect(JSON.stringify(memory.lines)).not.toMatch(/SECRETCODE|SECRETSTATE|oauth/)
  })

  test('reports the status of a Response returned by the handler', async () => {
    await probeRequest('/api/probe/raw')

    expect(memory.find('http.request')[0]).toMatchObject({ status: 418, level: 'warn' })
  })

  test('is warn for 4xx and error for 5xx', async () => {
    await probeRequest('/api/probe/missing')
    await probeRequest('/api/probe/boom')

    expect(memory.find('http.request').map((line) => [line.status, line.level])).toEqual([
      [404, 'warn'],
      [500, 'error'],
    ])
  })

  test('includes the method', async () => {
    await probeRequest(...jsonPost('/api/probe/credentials', { email: 'a@example.com', password: 'longenough' }))

    expect(memory.find('http.request')[0]).toMatchObject({ method: 'POST', status: 200 })
  })

  test('treats a trailing slash as the same route pattern', async () => {
    await probeRequest('/api/health/')

    expect(memory.find('http.request')[0]?.route).toBe('/api/health')
  })
})
