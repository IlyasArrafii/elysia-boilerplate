import { afterAll, describe, expect, test } from 'bun:test'
import { post } from '@repo/db'
import { eq } from 'drizzle-orm'
import { createUser, PASSWORD } from '../../helpers/auth'
import { fixtures, testDatabaseUrl, testDb } from '../../helpers/db'
import { runInApiProcess, UNREACHABLE_REDIS_URL } from '../../helpers/redis'

// The whole app on a Redis that refuses every connection (apps/api R40, ARCHITECTURE.md §6): the
// posts routes answer as usual from PostgreSQL, and every cache failure is a `cache.unavailable`
// event instead of an error. `utils/redis` resolves REDIS_URL once at import, so the app runs in a
// process of its own, which signs in through Better Auth's in-memory rate-limit fallback.

const db = await testDb()
const scope = fixtures(db)

afterAll(() => scope.cleanup())

interface OutageReport {
  statuses: Record<string, number>
  keptId: string
  doomedId: string
  listedIds: string[]
  cacheFailures: { source: string; operation: string; suppressed: number }[]
  httpErrors: number
}

function outageScript(input: { email: string; password: string; title: string; renamed: string; doomed: string }): string {
  return `
    const { app } = await import("./src/app.ts")
    const { env } = await import("./src/env.ts")
    const { telemetry } = await import("./src/utils/telemetry/index.ts")
    const { createMemorySink } = await import("./src/utils/telemetry/sinks/memory.ts")
    const memory = createMemorySink()
    telemetry.addSink(memory)
    const input = ${JSON.stringify(input)}
    const statuses = {}
    let cookie = ""

    async function call(step, method, path, body) {
      const headers = { origin: env.WEB_URL, [env.CLIENT_IP_HEADER]: "198.18.0.1" }
      if (cookie !== "") headers.cookie = cookie
      if (body !== undefined) headers["content-type"] = "application/json"
      const response = await app.handle(
        new Request("http://localhost" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      )
      statuses[step] = response.status
      return response
    }

    const signIn = await call("signIn", "POST", "/api/auth/sign-in/email", { email: input.email, password: input.password })
    cookie = (signIn.headers.getSetCookie().find((value) => value.startsWith("app.session_token=")) ?? "").split(";")[0]

    await call("list", "GET", "/api/posts?page=1")
    const kept = await (await call("create", "POST", "/api/posts", { title: input.title, content: "Written while Redis is down." })).json()
    await call("update", "PATCH", "/api/posts/" + kept.id, { title: input.renamed })
    const doomed = await (await call("createDoomed", "POST", "/api/posts", { title: input.doomed, content: "Deleted while Redis is down." })).json()
    await call("delete", "DELETE", "/api/posts/" + doomed.id)
    const listed = await (await call("listAfter", "GET", "/api/posts?page=1")).json()

    console.log(JSON.stringify({
      statuses,
      keptId: kept.id,
      doomedId: doomed.id,
      listedIds: listed.items.map((item) => item.id),
      cacheFailures: memory.find("cache.unavailable").map(({ source, operation, suppressed }) => ({ source, operation, suppressed })),
      httpErrors: memory.find("http.error").length,
    }))
    // The PostgreSQL pool keeps the process alive.
    process.exit(0)
  `
}

describe('posts routes with Redis unreachable', () => {
  test('GET is 200 and POST, PATCH and DELETE answer as usual, with the data in PostgreSQL', async () => {
    const author = await createUser(scope, db, 'user')
    const title = `Outage post ${scope.run.slice(0, 8)}`
    const renamed = `${title} renamed`
    const doomed = `${title} doomed`

    const result = await runInApiProcess(
      outageScript({ email: author.email, password: PASSWORD, title, renamed, doomed }),
      { LOG_LEVEL: 'silent', DATABASE_URL: testDatabaseUrl(), REDIS_URL: UNREACHABLE_REDIS_URL, LOG_MONGO_URL: '' },
      { timeoutMs: 30_000 },
    )
    if (result.exitCode !== 0) throw new Error(`The outage process failed:\n${result.stderr}`)
    const report = JSON.parse(result.stdout) as OutageReport

    expect(report.statuses).toEqual({ signIn: 200, list: 200, create: 201, update: 200, createDoomed: 201, delete: 204, listAfter: 200 })
    expect(report.httpErrors).toBe(0)

    const [kept] = await db.select({ title: post.title, authorId: post.authorId }).from(post).where(eq(post.id, report.keptId))
    expect(kept).toEqual({ title: renamed, authorId: author.id })
    expect(await db.select({ id: post.id }).from(post).where(eq(post.id, report.doomedId))).toEqual([])
    expect(report.listedIds).toContain(report.keptId)
    expect(report.listedIds).not.toContain(report.doomedId)

    // The list read failed, then each write's invalidation: one event per operation. Further failures
    // fall in the same 30 s windows, and reads and sets skip Redis while the breaker is open.
    const posts = report.cacheFailures.filter((failure) => failure.source === 'posts')
    const operations = posts.map((failure) => failure.operation)
    expect(operations).toEqual(expect.arrayContaining(['get', 'del', 'delPattern']))
    expect(new Set(operations).size).toBe(operations.length)
    expect(posts.every((failure) => failure.suppressed === 0)).toBe(true)

    // The write limit counted the four writes in memory: the first failure opened its breaker, so
    // the other writes never asked Redis and reported nothing more.
    expect(report.cacheFailures.filter((failure) => failure.source === 'ratelimit:posts-write')).toEqual([
      { source: 'ratelimit:posts-write', operation: 'increment', suppressed: 0 },
    ])
  }, 40_000)

  test('the write limit still applies from the memory counter', async () => {
    const author = await createUser(scope, db, 'user')
    const script = `
      const { app } = await import("./src/app.ts")
      const { env } = await import("./src/env.ts")
      const { telemetry } = await import("./src/utils/telemetry/index.ts")
      const { createMemorySink } = await import("./src/utils/telemetry/sinks/memory.ts")
      const memory = createMemorySink()
      telemetry.addSink(memory)
      const headers = { origin: env.WEB_URL, [env.CLIENT_IP_HEADER]: "198.18.0.2", "content-type": "application/json" }
      const send = (path, body) => app.handle(new Request("http://localhost" + path, { method: "POST", headers, body: JSON.stringify(body) }))

      const signIn = await send("/api/auth/sign-in/email", ${JSON.stringify({ email: author.email, password: PASSWORD })})
      headers.cookie = (signIn.headers.getSetCookie().find((value) => value.startsWith("app.session_token=")) ?? "").split(";")[0]
      // A DELETE of a post that does not exist is a counted write that leaves no row behind.
      const statuses = []
      for (let index = 0; index < 31; index++) {
        const response = await app.handle(new Request("http://localhost/api/posts/00000000-0000-4000-8000-000000000000", { method: "DELETE", headers }))
        statuses.push(response.status)
      }
      console.log(JSON.stringify({
        statuses,
        limited: memory.find("cache.unavailable").filter((event) => event.source === "ratelimit:posts-write").length,
        httpErrors: memory.find("http.error").filter((event) => event.status >= 500).length,
      }))
      process.exit(0)
    `

    const result = await runInApiProcess(
      script,
      { LOG_LEVEL: 'silent', DATABASE_URL: testDatabaseUrl(), REDIS_URL: UNREACHABLE_REDIS_URL, LOG_MONGO_URL: '' },
      { timeoutMs: 30_000 },
    )
    if (result.exitCode !== 0) throw new Error(`The outage process failed:\n${result.stderr}`)
    const report = JSON.parse(result.stdout) as { statuses: number[]; limited: number; httpErrors: number }

    // Thirty 404s (a missing post) use up the limit; the thirty-first write is refused before the handler.
    expect(report.statuses).toEqual([...Array.from({ length: 30 }, () => 404), 429])
    expect(report.limited).toBe(1)
    expect(report.httpErrors).toBe(0)
  }, 40_000)
})
