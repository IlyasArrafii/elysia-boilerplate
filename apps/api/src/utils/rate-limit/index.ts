import { rateLimit, type Generator } from 'elysia-rate-limit'
import { createRateLimitContext, type RateLimitContextOptions } from './context'

export { RATE_LIMIT_KEY_PREFIX } from './context'

// API.md §1. Sent with status 429, `Retry-After` and the `RateLimit-*` headers.
export const RATE_LIMITED = { code: 'RATE_LIMITED', message: 'Too many requests, try again later' } as const

export interface UserRateLimitOptions extends RateLimitContextOptions {
  // Requests allowed per user in each window; the next one is answered 429.
  max: number
  windowSeconds: number
}

// What the generator answers when no user was resolved, and `skip` lets through uncounted. The plugin's
// `onError` hook calls the generator before any macro has resolved the session (a body that fails to
// parse or validate), so throwing there would turn a 400 into a 500. With the limiter mounted after the
// `permission` macro, `beforeHandle` always has a user.
const UNRESOLVED = 'unresolved'

// The user ID, never the socket address: in production that is the proxy, shared by every user.
const byUser: Generator<{ user?: { id?: unknown } }> = (_request, _server, { user }) =>
  typeof user?.id === 'string' && user.id !== '' ? user.id : UNRESOLVED

// Two parameters on purpose: the plugin computes the key before calling `skip` only when `skip`
// declares the key parameter (`skip.length >= 2`).
const skipUnresolved = (_request: Request, key?: string): boolean => key === UNRESOLVED

// elysia-rate-limit 4.6.3 registers each limiter as an Elysia plugin named `elysia-rate-limit` with the
// seed `<max>:<duration>:<scoping>`, and Elysia keeps only the first plugin with a given name and seed
// in an instance: a second limiter with the same numbers in the same chain, or in a guard under a
// module that already has one, is dropped without a word. So the numbers identify the limiter, one
// name per set of numbers, and a name keeps its numbers (they decide its Redis keys and TTL). Building
// the same limiter again is allowed; it shares the name's counters.
const nameByNumbers = new Map<string, string>()
const numbersByName = new Map<string, string>()

function claim(name: string, max: number, windowSeconds: number): void {
  const numbers = `${max}/${windowSeconds}s`
  const holder = nameByNumbers.get(numbers)
  if (holder !== undefined && holder !== name) {
    throw new Error(
      `Rate limiter "${name}" has the same max and window (${numbers}) as "${holder}". elysia-rate-limit 4.6.3 identifies its plugin by these numbers, so Elysia could silently drop one of the two; change one of them`,
    )
  }
  const held = numbersByName.get(name)
  if (held !== undefined && held !== numbers) {
    throw new Error(`Rate limiter "${name}" already exists with ${held}; a name keeps its numbers, got ${numbers}`)
  }
  nameByNumbers.set(numbers, name)
  numbersByName.set(name, numbers)
}

// Per-user limit for a module's expensive routes (apps/api R51). Use it inside the guard that declares
// the routes' `permission`, so it runs after the session and the permission are checked: a 401 or a
// permission 403 is never counted, and every counted request has a user. A 403 the handler throws (an
// ownership check) is counted like any other answer. A route's own `permission` resolves after
// the limiter, which would then see no user and count nothing. Never on the Better Auth handler.
//
//   .guard({ permission: 'posts:write' }, (app) => app.use(postsWriteLimit).post(...))
//
// Counts every request that reaches the limiter, whatever the handler answers. A body that fails to
// parse or validate is answered before it, so it is not counted.
export function userRateLimit({ name, max, windowSeconds, store, counter }: UserRateLimitOptions) {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`Rate limiter "${name}" needs a positive whole max, got ${max}`)
  }
  // Checks the name; the plugin's `init` then checks the window.
  const context = createRateLimitContext({ name, store, counter })
  const plugin = rateLimit({
    scoping: 'scoped',
    max,
    duration: windowSeconds * 1000,
    generator: byUser,
    skip: skipUnresolved,
    countFailedRequest: true,
    errorResponse: Response.json(RATE_LIMITED, { status: 429 }),
    context,
  })
  claim(name, max, windowSeconds)
  return plugin
}
