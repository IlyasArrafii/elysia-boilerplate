// Type-only, and the client is built on the first command: importing this module never touches the
// `Bun` global, so it also loads under Node, where the Better Auth CLI imports utils/auth/auth.ts
// with the root `.env` (and its REDIS_URL) loaded.
import type { RedisClient } from 'bun'
import { env } from '../../env'
import { telemetry, type Telemetry } from '../telemetry'

const CONNECT_TIMEOUT_MS = 1000
const COMMAND_TIMEOUT_MS = 1000
const PROBE_TIMEOUT_MS = 1000

export type RedisState = 'up' | 'down'

export interface Redis {
  // Runs `run` on the connected client, reconnecting first when the connection was lost. Rejects
  // when Redis is unreachable, when `close()` was called, or when no reply came within `timeoutMs`.
  command<T>(run: (client: RedisClient) => Promise<T>, timeoutMs?: number): Promise<T>
  // Never rejects: anything but a PONG within the timeout is `down`.
  probe(timeoutMs?: number): Promise<RedisState>
  close(): void
}

export class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis did not reply within ${timeoutMs} ms`)
    this.name = 'RedisTimeoutError'
  }
}

export function createRedis(url: string): Redis {
  let client: RedisClient | undefined
  let closed = false

  async function connected(): Promise<RedisClient> {
    if (closed) throw new Error('Redis client is closed')
    // Bun's defaults queue commands and retry in the background, which holds a command for about
    // 30 s while Redis is away. Here a command fails at once instead, and the next one reconnects.
    client ??= new Bun.RedisClient(url, {
      autoReconnect: false,
      enableOfflineQueue: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    })
    if (!client.connected) await client.connect()
    return client
  }

  async function command<T>(run: (redis: RedisClient) => Promise<T>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // An open connection that stopped replying never fails on its own (Bun has no reply
        // timeout). Dropping it rejects every command still waiting on it, so none pile up, and the
        // next command reconnects.
        client?.close()
        reject(new RedisTimeoutError(timeoutMs))
      }, timeoutMs)
    })
    try {
      return await Promise.race([connected().then(run), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    command,

    async probe(timeoutMs = PROBE_TIMEOUT_MS) {
      try {
        return (await command((redis) => redis.ping(), timeoutMs)) === 'PONG' ? 'up' : 'down'
      } catch {
        return 'down'
      }
    },

    close() {
      closed = true
      client?.close()
    },
  }
}

// `null` is the memory fallback (REDIS_URL empty; env.ts refuses that in production). The fallback
// is announced once, here, because this is the one place that decides it.
export function resolveRedis(url: string | undefined, events: Telemetry): Redis | null {
  if (url !== undefined) return createRedis(url)

  events.emit('cache.fallback', { reason: 'REDIS_URL is empty' })
  return null
}

export const redis: Redis | null = resolveRedis(env.REDIS_URL, telemetry)

// For graceful shutdown (TASK-13). Safe to call more than once and on the memory fallback.
export function closeRedis(): void {
  redis?.close()
}
