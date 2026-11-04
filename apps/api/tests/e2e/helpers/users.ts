import { expect } from 'bun:test'
import { createClient, type E2eClient } from './client'

// Accounts for the API E2E flows (TESTING.md §3.2). Every account is new, with a unique email, so a
// file never depends on data another file made. The super_admin is the one the seed creates.

// Better Auth checks the Origin of cookie-carrying POSTs against its trusted origins (the web app).
export const WEB_ORIGIN = process.env.WEB_URL || 'http://localhost:3001'
export const PASSWORD = 'correct-horse-battery'

const run = crypto.randomUUID()
let count = 0

// Sign-up allows 3 and sign-in 5 a minute per client IP, which the API reads from `x-forwarded-for`.
// Each call gets its own random address in 198.19.0.0/16 (part of the 198.18.0.0/15 benchmarking
// range; posts.test.ts keeps its own 10.208.0.0/16), so files neither trip the limits nor use up each
// other's budget. A test about the limits passes one address to several calls on purpose.
export function testIp(): string {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint8Array(2))
  return `198.19.${high}.${low}`
}

export function send(
  client: E2eClient,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const all: Record<string, string> = { origin: WEB_ORIGIN, ...headers }
  if (body !== undefined) all['content-type'] = 'application/json'
  return client.request(path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) })
}

export interface Account {
  client: E2eClient
  id: string
  email: string
}

export function uniqueEmail(label: string): string {
  count++
  return `e2e+${label}-${run}-${count}@example.test`
}

// A new account (role user), signed in on its own client by the sign-up itself.
export async function signUp(label: string, baseUrl?: string): Promise<Account> {
  const client = createClient(baseUrl)
  const email = uniqueEmail(label)
  const response = await send(
    client,
    'POST',
    '/api/auth/sign-up/email',
    { email, password: PASSWORD, name: `E2E ${label} ${count}` },
    { 'x-forwarded-for': testIp() },
  )
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { client, id: user.id, email }
}

// One sign-in attempt on a fresh client. The caller asserts the status.
export async function signIn(email: string, password: string, ip: string = testIp()): Promise<{ client: E2eClient; response: Response }> {
  const client = createClient()
  const response = await send(client, 'POST', '/api/auth/sign-in/email', { email, password }, { 'x-forwarded-for': ip })
  return { client, response }
}

export async function signedInSuperAdmin(): Promise<Account> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must be set to the seeded super_admin (TESTING.md §3.2)')
  }
  const { client, response } = await signIn(email, password)
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { client, id: user.id, email }
}
