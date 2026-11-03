import { describe, expect, test } from 'bun:test'
import { createClient } from '../helpers/client'

describe('GET /api/health on the running stack', () => {
  test('answers 200 ok with a request id', async () => {
    const response = await createClient().request('/api/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeString()
    expect(await response.json()).toMatchObject({ status: 'ok', uptime: expect.any(Number) })
  })
})
