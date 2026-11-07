import type { SecondaryStorage } from '@repo/auth'
import { redisStorage } from '@better-auth/redis-storage'
import { Redis, type RedisOptions } from 'ioredis'
import { env, type AuthRedisDriver } from '../../env'
import { cacheStore, type CacheStore } from '../cache'
import { cacheFailureReporter } from '../cache/report'
import { AUTH_KEY_PREFIX, createSecondaryStorage, guardAuthStorage, type GuardAuthStorageOptions } from './storage'

// ioredis's defaults queue a command offline and retry it across 20 reconnects: with Redis down, a GET
// failed after about 10.5 s and an increment after about 32.5 s. The guard's 1 s deadline bounds that
// anyway; these make a command fail at once instead, so it does not linger after the guard gave up.
// - `lazyConnect`: building the client opens nothing, so importing `auth.ts` (the Better Auth CLI, on
//   Node) never dials Redis. The first increment connects (`officialAuthStorage`).
// - `enableReadyCheck: false` and `disableClientInfo: true`: no `INFO` and no `CLIENT SETINFO` on
//   connect, so the server sees only what VALKEY-MIGRATION.md §3.4 grants (`AUTH`, then `EVAL`).
//   Without the ready check, a command sent while Redis is still loading gets `LOADING` and falls back.
// - `disconnectTimeout`: `disconnect()` destroys a socket that has not closed by then. Its timer is
//   cleared only by the socket's `'close'`, which a client closed between two reconnects already had,
//   so the timer runs out and holds the process that long. ioredis's 2 s would also outlast the
//   shutdown step (`clients` 1000 ms) on a peer that never answers the FIN; 500 ms stays inside it.
// Reconnects keep ioredis's default backoff (50 ms more per attempt, at most 2 s), forever.
export const OFFICIAL_CLIENT_OPTIONS = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,
  connectTimeout: 1000,
  disconnectTimeout: 500,
  enableReadyCheck: false,
  disableClientInfo: true,
} as const satisfies RedisOptions

// ioredis for the official driver. Without an `'error'` listener ioredis prints "Unhandled error event"
// with the stack on every failed reconnect; `onError` gets them instead. The URL is never logged: it
// may carry a password.
export function createAuthRedisClient(url: string, onError: (error: unknown) => void): Redis {
  const client = new Redis(url, OFFICIAL_CLIENT_OPTIONS)
  client.on('error', onError)
  return client
}

// `@better-auth/redis-storage` behind the same guard as the custom driver (DEC-057), so only `increment`
// reaches it, with the window already a whole number of seconds and long keys already hashed. The
// driver adds `auth:` itself (`keyPrefix`), after the guard bounded the key, so both drivers count
// the same Redis key and switching drivers keeps the counters. Its `set` with no TTL or TTL 0 writes a
// key that never expires; the guard never calls it.
export function officialAuthStorage(client: Redis, options: GuardAuthStorageOptions = {}): SecondaryStorage {
  const official = redisStorage({ client, keyPrefix: AUTH_KEY_PREFIX })
  // A lazy client connects on its first command, but with the offline queue off that command is
  // refused while the connection opens. So the first increment opens it and waits; later ones find
  // ioredis connected or reconnecting on its own. The error is the `'error'` listener's to report.
  let firstConnect: Promise<void> | undefined
  return guardAuthStorage(
    {
      async increment(key, ttl) {
        if (client.status === 'wait') firstConnect ??= client.connect().catch(() => undefined)
        await firstConnect
        return official.increment(key, ttl)
      },
    },
    options,
  )
}

// Closes at once and stops reconnecting; no `QUIT`, which the restricted user is not granted. Shutdown
// runs it after the HTTP server stopped, so no increment is in flight. Resolves once the socket has
// closed (within `disconnectTimeout`), or at once when there is none.
export function closeAuthRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return Promise.resolve()
  const hasSocket = client.status === 'connecting' || client.status === 'connect' || client.status === 'ready'
  const ended = new Promise<void>((resolve) => client.once('end', () => resolve()))
  client.disconnect()
  return hasSocket ? ended : Promise.resolve()
}

export interface AuthStorage {
  storage: SecondaryStorage
  // The official driver's connection; the custom driver has none of its own (it uses `utils/redis`).
  client?: Redis
  close(): Promise<void>
}

export interface AuthStorageConfig {
  driver: AuthRedisDriver
  redisUrl: string | undefined
  store: CacheStore
}

// `AUTH_REDIS_DRIVER` (DEC-057). `custom` counts through the app's cache store, on the `utils/redis`
// connection. `official` opens a second connection of its own. Both report as `cache.unavailable`
// from `auth`; the official driver's connection errors share the guard's 30 s window, so an outage
// is one event per window whichever noticed it first.
export function createAuthStorage({ driver, redisUrl, store }: AuthStorageConfig): AuthStorage {
  if (driver === 'custom') return { storage: createSecondaryStorage(store), close: async () => undefined }
  if (redisUrl === undefined) throw new Error('AUTH_REDIS_DRIVER=official needs REDIS_URL')

  const report = cacheFailureReporter('auth')
  const client = createAuthRedisClient(redisUrl, (error) => report('increment', error))
  return {
    storage: officialAuthStorage(client, { onFailure: report }),
    client,
    close: () => closeAuthRedisClient(client),
  }
}

export const authStorage: AuthStorage = createAuthStorage({
  driver: env.AUTH_REDIS_DRIVER,
  redisUrl: env.REDIS_URL,
  store: cacheStore,
})

// For graceful shutdown (ARCHITECTURE.md §8). Safe to call more than once.
export function closeAuthRedis(): Promise<void> {
  return authStorage.close()
}
