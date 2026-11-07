import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { auth, MAX_USER_MUTATION_BODY_BYTES } from '../../../src/utils/auth'
import { memory, request } from '../../helpers/app'
import { headers, prepareTestDatabase, storedUser, testUsers, type TestUser } from './setup'

// The user mutation endpoints buffer the body before queueing for the lock (utils/auth/index.ts).
// These pin what reaches Better Auth: the exact bytes, an absent body kept absent, an empty body kept
// empty, and nothing at all past the 16 KiB cap.

const ready = await prepareTestDatabase()
const { createUser, cleanup } = testUsers()

afterAll(cleanup)

const BAN_PATH = '/api/auth/admin/ban-user'
const encoder = new TextEncoder()

// What Better Auth's handler was given, one entry per call: the body bytes, or null for no body.
let received: (Uint8Array | null)[] = []
let spy: ReturnType<typeof spyOn> | undefined

function recordHandlerBodies(): void {
  const original = auth.handler
  received = []
  spy = spyOn(auth, 'handler').mockImplementation(async (req: Request) => {
    received.push(req.body === null ? null : new Uint8Array(await req.clone().arrayBuffer()))
    return original(req)
  })
}

beforeEach(() => memory.clear())
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

function post(caller: TestUser | null, body: RequestInit['body'], contentType = 'application/json'): Promise<Response> {
  const extra: Record<string, string> = { 'content-type': contentType }
  if (caller !== null) extra.cookie = caller.cookie
  return request(BAN_PATH, { method: 'POST', headers: headers(extra), body })
}

// A ban-user body padded with trailing JSON whitespace to exactly `size` bytes.
function banBody(userId: string, banReason: string, size: number): Uint8Array<ArrayBuffer> {
  const json = JSON.stringify({ userId, banReason })
  const bytes = encoder.encode(json + ' '.repeat(size - encoder.encode(json).byteLength))
  expect(bytes.byteLength).toBe(size)
  return bytes
}

describe.skipIf(!ready)('user mutation body buffering (needs the test PostgreSQL)', () => {
  test('non-ASCII bytes reach Better Auth unchanged and are stored as sent', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    const banReason = 'Spam — 不正利用 🚫 ñ'
    const sent = encoder.encode(JSON.stringify({ userId: target.id, banReason }))
    recordHandlerBodies()

    const response = await post(admin, sent)

    expect(response.status).toBe(200)
    expect(received).toEqual([sent])
    expect(await storedUser(target.id)).toMatchObject({ banned: true, banReason })
  })

  test('a body of exactly the cap, counted in bytes, is accepted whole', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    const sent = banBody(target.id, 'ü'.repeat(100), MAX_USER_MUTATION_BODY_BYTES)
    recordHandlerBodies()

    const response = await post(admin, sent)

    expect(response.status).toBe(200)
    expect(received).toEqual([sent])
    expect(await storedUser(target.id)).toMatchObject({ banned: true, banReason: 'ü'.repeat(100) })
  })

  test('one byte over the cap is 413 PAYLOAD_TOO_LARGE, and Better Auth never sees it', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    recordHandlerBodies()

    const response = await post(admin, banBody(target.id, 'spam', MAX_USER_MUTATION_BODY_BYTES + 1))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(received).toEqual([])
    expect(await storedUser(target.id)).toMatchObject({ banned: false })
  })

  test('an endless upload is cut off at the cap instead of being read to the end', async () => {
    const admin = await createUser('super_admin')
    const chunk = new Uint8Array(1024).fill(0x20)
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
      },
    })
    recordHandlerBodies()

    const response = await post(admin, endless)

    expect(response.status).toBe(413)
    expect(received).toEqual([])
    // A few chunks of read-ahead at most, never the whole (infinite) stream.
    expect(pulled * chunk.byteLength).toBeLessThan(MAX_USER_MUTATION_BODY_BYTES * 2)
  })

  test('an empty body stays empty and a missing body stays missing', async () => {
    const admin = await createUser('super_admin')
    recordHandlerBodies()

    const empty = await post(admin, '')
    const missing = await post(admin, null)

    expect(empty.status).not.toBe(413)
    expect(missing.status).not.toBe(413)
    expect(received).toEqual([new Uint8Array(0), null])
  })

  test('a guest is 401 before any of the body is read, however large it is', async () => {
    recordHandlerBodies()

    const response = await post(null, new Uint8Array(MAX_USER_MUTATION_BODY_BYTES * 4))

    expect(response.status).toBe(401)
    expect(received).toEqual([])
  })
})
