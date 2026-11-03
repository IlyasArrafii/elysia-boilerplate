import { beforeEach, describe, expect, test } from 'bun:test'
import { moduleError, ModuleError } from '../../../src/utils/error'
import { jsonPost, memory } from '../../helpers/app'
import { probeRequest } from '../../helpers/probe'

beforeEach(() => memory.clear())

describe('moduleError', () => {
  test('carries the module, status, code and message', () => {
    const error = moduleError('posts', 404, 'POST_NOT_FOUND', 'Post not found')

    expect(error).toBeInstanceOf(ModuleError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'ModuleError',
      sourceModule: 'posts',
      status: 404,
      code: 'POST_NOT_FOUND',
      message: 'Post not found',
    })
  })

  test('only accepts an UPPER_SNAKE_CASE code and a client error status', () => {
    // @ts-expect-error codes are upper case
    moduleError('posts', 404, 'post_not_found', 'x')
    // @ts-expect-error 500 is for unexpected errors, which are never thrown on purpose
    moduleError('posts', 500, 'BROKEN', 'x')
  })

  test('is answered as { code, message } with its status', async () => {
    const response = await probeRequest('/api/probe/missing')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'PROBE_NOT_FOUND', message: 'Probe not found' })
  })

  test('is logged as http.error with the module, no route, and warn for a 4xx', async () => {
    await probeRequest('/api/probe/missing')

    const [line] = memory.find('http.error')
    expect(line).toMatchObject({
      level: 'warn',
      kind: 'error',
      module: 'probe',
      sourceModule: 'probe',
      status: 404,
      code: 'PROBE_NOT_FOUND',
    })
    expect(line).not.toHaveProperty('route')
    expect(line).not.toHaveProperty('path')
  })

  test('reports the module that threw as sourceModule when another module handles the route', async () => {
    const response = await probeRequest('/api/probe/cross')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'OTHER_CONFLICT', message: 'Conflict in other module' })
    expect(memory.find('http.error')[0]).toMatchObject({ module: 'probe', sourceModule: 'other', code: 'OTHER_CONFLICT' })
  })
})

describe('unexpected errors', () => {
  test('answer 500 INTERNAL_ERROR with a generic message and nothing else', async () => {
    const response = await probeRequest('/api/probe/boom')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })

  test('never put the library message, stack or module in the response', async () => {
    const response = await probeRequest('/api/probe/boom')
    const text = await response.clone().text()

    expect(text).not.toMatch(/connection to db lost|probe|stack|at .*\.ts/)
    expect([...response.headers.keys()].filter((key) => key.includes('module'))).toEqual([])
  })

  test('are logged as http.error with the module and the stack, no route and no sourceModule', async () => {
    await probeRequest('/api/probe/boom')

    const [line] = memory.find('http.error')
    expect(line).toMatchObject({
      level: 'error',
      module: 'probe',
      status: 500,
      code: 'INTERNAL_ERROR',
      err: { name: 'Error', message: 'connection to db lost' },
    })
    expect(String((line?.err as { stack?: string }).stack)).toContain('connection to db lost')
    expect(line).not.toHaveProperty('route')
    expect(line).not.toHaveProperty('sourceModule')
  })

  test('are caught for a handler that throws after an await', async () => {
    const response = await probeRequest('/api/probe/leaky-message')

    expect(response.status).toBe(500)
    expect(memory.find('http.error')).toHaveLength(1)
  })
})

describe('framework errors', () => {
  test('unknown route is 404 NOT_FOUND', async () => {
    const response = await probeRequest('/api/nowhere')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Not found' })
    expect(memory.find('http.error')[0]).toMatchObject({ module: 'core', status: 404, code: 'NOT_FOUND' })
  })

  test('malformed JSON is 400 VALIDATION_ERROR and its parser message is not logged', async () => {
    const response = await probeRequest('/api/probe/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"hunter2-secret',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid request' })
    expect(JSON.stringify(memory.lines)).not.toContain('hunter2')
  })

  test('validation failure is 400 with field paths and rule names only', async () => {
    const response = await probeRequest(
      ...jsonPost('/api/probe/credentials', { email: 'victim-not-an-email', password: 'short' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: {
        fields: expect.arrayContaining([
          { path: '/email', rule: 'format' },
          { path: '/password', rule: 'minLength' },
        ]),
      },
    })
    expect(JSON.stringify(body)).not.toMatch(/victim|short/)
  })

  test('validation failure is logged with the same fields and none of the values', async () => {
    await probeRequest(...jsonPost('/api/probe/credentials', { email: 'victim-not-an-email', password: 'short' }))

    const [line] = memory.find('http.error')
    expect(line).toMatchObject({ module: 'probe', status: 400, code: 'VALIDATION_ERROR', level: 'warn' })
    expect(line?.fields).toEqual(
      expect.arrayContaining([
        { path: '/email', rule: 'format' },
        { path: '/password', rule: 'minLength' },
      ]),
    )
    expect(JSON.stringify(memory.lines)).not.toMatch(/victim|short/)
  })

  test('reports a type mismatch and a missing field as a type rule', async () => {
    const response = await probeRequest(...jsonPost('/api/probe/credentials', { email: 42 }))
    const body = (await response.json()) as { details: { fields: { path: string; rule: string }[] } }

    expect(body.details.fields).toEqual(
      expect.arrayContaining([
        { path: '/email', rule: 'type' },
        { path: '/password', rule: 'type' },
      ]),
    )
  })
})

describe('thrown status responses', () => {
  test('keep their status and { code, message } body and are logged', async () => {
    const response = await probeRequest('/api/probe/forbidden')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' })
    expect(memory.find('http.error')[0]).toMatchObject({ module: 'probe', status: 403, code: 'FORBIDDEN', level: 'warn' })
  })

  test('without a { code, message } body are treated as unexpected', async () => {
    const response = await probeRequest('/api/probe/odd-status')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })
})
