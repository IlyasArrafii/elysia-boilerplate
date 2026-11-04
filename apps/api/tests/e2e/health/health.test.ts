import { describe, expect, test } from 'bun:test'
import { createClient } from '../helpers/client'

// The E2E stack runs the API with PostgreSQL, Redis and the MongoDB log store all configured
// (TESTING.md §3.2), so every dependency must report `up`: `disabled` would mean the API under test
// is not the stack the other E2E files assume.
describe('GET /api/health on the running stack', () => {
  test('answers 200 ok with every dependency up and a request id', async () => {
    const response = await createClient().request('/api/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeString()
    expect(await response.json()).toEqual({ status: 'ok', db: 'up', redis: 'up', logStore: 'up', uptime: expect.any(Number) })
  })
})
