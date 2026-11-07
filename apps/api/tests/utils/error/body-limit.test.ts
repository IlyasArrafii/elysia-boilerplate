import { describe, expect, test } from 'bun:test'
import { MAX_REQUEST_BODY_BYTES } from '../../../src/app'
import { runInApiProcess } from '../../helpers/redis'

// The body limit is a Bun.serve option of the root app (`serve` in src/app.ts), which `app.handle()`
// never goes through, so these requests travel over a real port. That port is opened in a child
// process: the root app is shared by every test file in this process, and the health tests check
// that importing it opens none.
// Elysia parses and validates a body before any route option runs, the `auth` and `permission` macros
// included, so without the limit an anonymous caller could make any route with a body buffer ~128 MB.
// The child adds a probe route with a body schema to the real app before it listens: no POST route
// outside `/api/auth/*` is shared by every project (posts is an example module), and this test must
// outlive removing it. Hooks are added before the probe, so the global ones (csrf, logger, error
// handler) run for it as for any module route.
//
// The requests are written on a raw socket. A client that streams 1 MiB while Bun has already
// answered 413 and closed the connection sees a reset or a 413, depending on timing; declaring the
// size and sending no body makes the answer deterministic and shows it comes from the header alone.

// Added to the root app, so it is served under the app's `/api` prefix.
const PROBE_ROUTE = '/body-limit-probe'

const SCRIPT = `
  const net = await import("node:net")
  const { t } = await import("elysia")
  const { app, MAX_REQUEST_BODY_BYTES: max } = await import("./src/app.ts")
  const { telemetry } = await import("./src/utils/telemetry/index.ts")
  const { createMemorySink } = await import("./src/utils/telemetry/sinks/memory.ts")
  const memory = createMemorySink()
  telemetry.addSink(memory)
  app.post("${PROBE_ROUTE}", ({ body }) => body, {
    body: t.Object({ title: t.String(), content: t.String({ maxLength: 100 }) }),
  })
  app.listen({ port: 0, hostname: "127.0.0.1" })
  const CRLF = String.fromCharCode(13, 10)

  // Valid JSON of exactly the given size, with a content too long for the probe's schema.
  function jsonOfSize(size) {
    const head = '{"title":"title","content":"'
    const tail = '"}'
    return head + "x".repeat(size - head.length - tail.length) + tail
  }

  // Resolves with the status code, "reset" when the connection fails before any answer, or "none".
  function exchange(headers, chunks) {
    return new Promise((resolve) => {
      let answer = ""
      const finish = () => resolve(answer === "" ? "none" : Number(answer.slice(9, 12)))
      const socket = net.connect(app.server.port, "127.0.0.1")
      socket.setTimeout(5000, () => socket.destroy())
      socket.on("data", (data) => { answer += data.toString() })
      socket.on("error", () => resolve(answer === "" ? "reset" : Number(answer.slice(9, 12))))
      socket.on("close", finish)
      const head = ["POST /api${PROBE_ROUTE} HTTP/1.1", "Host: 127.0.0.1", "Content-Type: application/json", ...headers]
      socket.write(head.join(CRLF) + CRLF + CRLF)
      for (const chunk of chunks) socket.write(chunk)
      socket.end()
    })
  }

  async function send(headers, chunks) {
    memory.clear()
    const status = await exchange(headers, chunks)
    // http.request is emitted after the response is sent (onAfterResponse).
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { status, reachedApp: memory.find("http.request").length > 0 }
  }

  const atLimit = jsonOfSize(max)
  const overLimit = jsonOfSize(max + 1)
  const results = {
    max,
    atLimit: await send(["Content-Length: " + max], [atLimit]),
    overLimit: await send(["Content-Length: " + (max + 1)], []),
    chunkedOverLimit: await send(
      ["Transfer-Encoding: chunked"],
      [(max + 1).toString(16) + CRLF, overLimit, CRLF + "0" + CRLF + CRLF],
    ),
  }
  console.log(JSON.stringify(results))
  await app.stop(true)
`

interface Sent {
  status: number | 'reset' | 'none'
  reachedApp: boolean
}

interface Results {
  max: number
  atLimit: Sent
  overLimit: Sent
  chunkedOverLimit: Sent
}

async function sendOverRealPort(): Promise<Results> {
  const result = await runInApiProcess(SCRIPT, { LOG_LEVEL: 'silent' }, { timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(`The API process failed:\n${result.stdout}${result.stderr}`)
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(lastLine) as Results
}

describe('request body limit', () => {
  test('is 1 MiB', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024)
  })

  test('rejects an oversized body before the app or the permission check sees it', async () => {
    const results = await sendOverRealPort()

    expect(results.max).toBe(MAX_REQUEST_BODY_BYTES)
    // At the limit the body is read and parsed, and the probe's schema rejects it: 400, the answer
    // validation gives before any `auth` or `permission` check (API.md §3.4).
    expect(results.atLimit).toEqual({ status: 400, reachedApp: true })
    // One byte over: Bun answers 413 from the Content-Length alone, before reading any body and
    // before any hook, so the request never becomes an http.request event.
    expect(results.overLimit).toEqual({ status: 413, reachedApp: false })
    // Chunked, with no Content-Length: Bun stops reading at the limit, so at most 1 MiB is buffered.
    expect(results.chunkedOverLimit.status).toBe(413)
  }, 40_000)
})
