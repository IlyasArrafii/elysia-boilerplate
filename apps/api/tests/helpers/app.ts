import { app } from '../../src/app'
import { telemetry } from '../../src/utils/telemetry'
import { createMemorySink } from '../../src/utils/telemetry/sinks/memory'

// Every test file shares one memory sink on the real telemetry; call `memory.clear()` in `beforeEach`.
export const memory = createMemorySink()
telemetry.addSink(memory)

// Elysia finds the path by skipping the first 11 characters of the URL, so the host must be
// at least 4 characters long: `http://x/...` would resolve to the wrong route.
export const ORIGIN = 'http://localhost'

type Handler = { handle(request: Request): Response | Promise<Response> }

// Elysia runs `onAfterResponse` hooks with `setImmediate` once the response is built, which is
// where `http.request` is emitted. One more tick here lets a test read it right after the call.
export function requestFrom(target: Handler) {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await target.handle(new Request(`${ORIGIN}${path}`, init))
    await new Promise<void>((resolve) => setImmediate(resolve))
    return response
  }
}

// Never opens a port: `app.handle` calls the handler directly (TESTING.md §3).
export const request = requestFrom(app)

export function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  return [path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }]
}
