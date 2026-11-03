import { beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { app } from '../../../src/app'
import { mountModule, moduleScope } from '../../../src/utils/logger/module'
import { jsonPost, memory } from '../../helpers/app'
import { probe, probeRequest } from '../../helpers/probe'

beforeEach(() => memory.clear())

const logged = (event: string) => memory.find(event)

describe('moduleScope', () => {
  test('tags the request and the events of the module that owns the route', async () => {
    const response = await probeRequest('/api/probe/ok')

    const [line] = logged('http.request')
    expect(line).toMatchObject({ module: 'probe', requestId: response.headers.get('x-request-id') })
  })

  test('tags a validation failure with the module, because the hook runs before validation', async () => {
    await probeRequest(...jsonPost('/api/probe/credentials', { email: 'not-an-email', password: 'short' }))

    expect(logged('http.error')[0]).toMatchObject({ module: 'probe', status: 400 })
    expect(logged('http.request')[0]).toMatchObject({ module: 'probe', status: 400 })
  })

  test('does not tag routes of another controller', async () => {
    await probeRequest('/api/health')

    expect(logged('http.request')[0]).toMatchObject({ module: 'health' })
  })

  test('uses core for an unknown route', async () => {
    await probeRequest('/api/does-not-exist')

    expect(logged('http.error')[0]).toMatchObject({ module: 'core', code: 'NOT_FOUND' })
    expect(logged('http.request')[0]).toMatchObject({ module: 'core' })
  })

  test('uses core for a malformed JSON body, which fails before the module is known', async () => {
    await probeRequest('/api/probe/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":',
    })

    expect(logged('http.error')[0]).toMatchObject({ module: 'core', status: 400 })
    expect(logged('http.request')[0]).toMatchObject({ module: 'core', route: '/api/probe/credentials' })
  })

  test('keeps modules apart across concurrent requests', async () => {
    const responses = await Promise.all([
      probeRequest('/api/probe/ok'),
      probeRequest('/api/health'),
      probeRequest('/api/nope'),
      probeRequest('/api/probe/items/1'),
    ])
    const expected = ['probe', 'health', 'core', 'probe']

    responses.forEach((response, index) => {
      const requestId = response.headers.get('x-request-id')
      const line = logged('http.request').find((candidate) => candidate.requestId === requestId)
      expect(line?.module).toBe(expected[index])
    })
  })
})

describe('mountModule (startup check)', () => {
  test('returns a valid controller unchanged', () => {
    expect(mountModule(probe)).toBe(probe)
  })

  test('the root app mounts its modules without throwing', () => {
    expect(app.routes.some((route) => route.path === '/api/health/')).toBe(true)
  })

  test('fails startup for a controller without moduleScope', () => {
    const bare = new Elysia({ name: 'posts', prefix: '/posts' }).get('/', () => 'ok')

    expect(() => mountModule(bare)).toThrow(/Module "posts" must start with \.use\(moduleScope\("posts"\)\)/)
  })

  test('fails startup when the moduleScope name is a typo', () => {
    const typo = new Elysia({ name: 'posts', prefix: '/posts' }).use(moduleScope('post')).get('/', () => 'ok')

    expect(() => mountModule(typo)).toThrow(/Module "posts" uses moduleScope\("post"\)/)
  })

  test('fails startup when the moduleScope name belongs to another module', () => {
    const copied = new Elysia({ name: 'posts', prefix: '/posts' }).use(moduleScope('health')).get('/', () => 'ok')

    expect(() => mountModule(copied)).toThrow(/uses moduleScope\("health"\)/)
  })

  test('fails startup for an unnamed controller', () => {
    const unnamed = new Elysia({ prefix: '/posts' }).use(moduleScope('posts')).get('/', () => 'ok')

    expect(() => mountModule(unnamed)).toThrow(/must be named/)
  })
})
