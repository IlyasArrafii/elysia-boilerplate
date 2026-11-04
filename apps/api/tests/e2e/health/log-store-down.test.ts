import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { testDatabaseUrl } from '../../helpers/db'
import { freePort } from '../../helpers/silent-server'
import { createClient } from '../helpers/client'
import { send, signUp } from '../helpers/users'

// `logStore: "down"` is still 200 when MongoDB is stopped (TESTING.md §3.2, API.md §3.2). Stopping the
// stack's MongoDB would break the other E2E files running against it (posts reads its logs), so this
// file starts a second API process of its own on the same test PostgreSQL and the stack's Redis, with
// LOG_MONGO_URL pointing at a port nothing listens on: the connection is refused, as for a stopped
// container. Needs E2E_REDIS_URL (the stack's Redis) besides what the other E2E files need.

const API_ROOT = resolve(import.meta.dir, '../../..')
const STARTUP_TIMEOUT_MS = 20_000

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the log-store-down E2E flow (see the top of this file)`)
  return value
}

let api: ReturnType<typeof Bun.spawn> | undefined
let baseUrl: string

async function waitUntilAnswering(url: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the API exited during startup with code ${child.exitCode}`)
    const answered = await fetch(url).then(
      () => true,
      () => false,
    )
    if (answered) return
    await Bun.sleep(100)
  }
  throw new Error(`the API did not answer ${url} within ${STARTUP_TIMEOUT_MS} ms`)
}

beforeAll(async () => {
  const port = freePort()
  const stoppedMongoPort = freePort()
  baseUrl = `http://127.0.0.1:${port}`
  api = Bun.spawn({
    cmd: [process.execPath, 'src/index.ts'],
    cwd: API_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: required('E2E_REDIS_URL'),
      LOG_MONGO_URL: `mongodb://log_writer:unused@127.0.0.1:${stoppedMongoPort}/app_logs?authSource=app_logs`,
      LOG_MONGO_ADMIN_URL: '',
    },
    stdout: 'ignore',
    stderr: 'inherit',
    // A safety net if afterAll never runs: the child must not outlive the test run.
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  await waitUntilAnswering(`${baseUrl}/api/health`, api)
}, STARTUP_TIMEOUT_MS + 5000)

afterAll(async () => {
  if (api === undefined) return
  api.kill()
  await api.exited
})

describe('GET /api/health with MongoDB stopped', () => {
  test('answers 200 ok with logStore down, and the API keeps serving requests', async () => {
    const response = await createClient(baseUrl).request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', db: 'up', redis: 'up', logStore: 'down', uptime: expect.any(Number) })

    // Logging must not take the API down: a sign-up and an authenticated read still succeed.
    const account = await signUp('health-log-down', baseUrl)
    const posts = await send(account.client, 'GET', '/api/posts?page=1&limit=1')
    expect(posts.status).toBe(200)
    expect(posts.headers.get('x-request-id')).toBeString()
  })
})
