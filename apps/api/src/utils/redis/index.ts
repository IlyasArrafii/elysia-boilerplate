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

// One command and its arguments, e.g. `['INCR', 'auth:rate:1.2.3.4']`.
export type RedisCommandLine = readonly [command: string, ...args: string[]]

export interface Redis {
  // Runs `run` on the connected client, reconnecting first when the connection was lost. Rejects
  // when Redis is unreachable, when `close()` was called, or when no reply came within `timeoutMs`.
  command<T>(run: (client: RedisClient) => Promise<T>, timeoutMs?: number): Promise<T>
  // Runs the commands as one MULTI/EXEC, on a connection of its own, and resolves to EXEC's replies,
  // one per command. A command that failed inside the transaction comes back as an `Error` element:
  // Redis has no rollback, so the others still ran, and the caller must check every element.
  // Rejects like `command`, when MULTI is refused (nothing ran), and when the transaction was
  // refused as a whole (EXECABORT). A timeout before the transaction was sent means it never ran;
  // after, or on a lost connection, the outcome is unknown (EXEC may have run), so it is never
  // retried here.
  // Transactions started while one is in flight share the next MULTI/EXEC (see transactionQueue),
  // so failures before EXEC are shared too: a command Redis refuses to queue (wrong arity, unknown
  // command), a refused MULTI, a timeout or a lost connection rejects every caller in that batch.
  // Errors while EXEC runs stay per command, as `Error` elements in each caller's own replies.
  // Only send commands Redis will queue.
  transaction(commands: readonly RedisCommandLine[], timeoutMs?: number): Promise<unknown[]>
  // Never rejects: anything but a PONG within the timeout is `down`. A PING whose connection turns
  // out to have been closed already is sent once more, on a new connection, within the same timeout.
  probe(timeoutMs?: number): Promise<RedisState>
  close(): void
}

export class RedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis did not reply within ${timeoutMs} ms`)
    this.name = 'RedisTimeoutError'
  }
}

// MULTI or a queued command got a reply other than OK / QUEUED, so the commands may not have run
// as one transaction.
export class RedisTransactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedisTransactionError'
  }
}

interface Connection {
  connected(): Promise<RedisClient>
  // Rejects every reply still pending on it; the next `connected()` reconnects.
  drop(): void
}

function lazyConnection(url: string, isClosed: () => boolean): Connection {
  let client: RedisClient | undefined
  return {
    async connected() {
      if (isClosed()) throw new Error('Redis client is closed')
      // Bun's defaults queue commands and retry in the background, which holds a command for about
      // 30 s while Redis is away. Here a command fails at once instead, and the next one reconnects.
      client ??= new Bun.RedisClient(url, {
        autoReconnect: false,
        enableOfflineQueue: false,
        connectionTimeout: CONNECT_TIMEOUT_MS,
      })
      if (!client.connected) await client.connect()
      return client
    },
    drop() {
      client?.close()
    },
  }
}

// Bun rejects a command with this code when its connection closed before the command's reply came.
function isConnectionClosed(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_REDIS_CONNECTION_CLOSED'
}

interface DeadlineOptions {
  // Run `run` once more, on a new connection, when its connection closed before its reply came.
  // Redis may close a connection (CLIENT KILL, its `timeout`, a restart) and its FIN reach Bun only
  // after a command was written to it: `connected` is still true then, so nothing can catch the dead
  // socket before reuse. That command may or may not have run, so only a `run` that is safe to send
  // twice may set this (PING, never INCR or MULTI).
  retryLostConnection?: boolean
}

async function withDeadline<T>(
  connection: Connection,
  run: (client: RedisClient) => Promise<T>,
  timeoutMs: number,
  { retryLostConnection = false }: DeadlineOptions = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      // An open connection that stopped replying never fails on its own (Bun has no reply
      // timeout). Dropping it rejects every command still waiting on it, so none pile up, and the
      // next command reconnects.
      connection.drop()
      reject(new RedisTimeoutError(timeoutMs))
    }, timeoutMs)
  })

  // A failed connect is never retried, and neither is a command the deadline's own drop closed:
  // nothing would bound the retry once the deadline has passed.
  async function attempt(retry: boolean): Promise<T> {
    const client = await connection.connected()
    try {
      return await run(client)
    } catch (error) {
      if (!retry || expired || !isConnectionClosed(error)) throw error
    }
    return attempt(false)
  }

  try {
    return await Promise.race([attempt(retryLostConnection), deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Waits for MULTI's OK before sending anything else: Redis can refuse MULTI alone (an ACL that
// denies it), and commands sent along with it would then run one by one, outside any transaction.
// The commands and EXEC then go out in one synchronous run, which Bun writes in order, and nothing
// else uses this connection meanwhile (one batch in flight). Every reply is awaited through one
// Promise.all, so a dropped connection leaves no unhandled rejection.
async function runTransaction(
  client: RedisClient,
  connection: Connection,
  commands: readonly RedisCommandLine[],
): Promise<unknown[]> {
  // A refused MULTI rejects here and leaves the connection outside a transaction, as it was.
  const multi = await client.send('MULTI', [])
  if (multi !== 'OK') {
    // Not a refusal Redis would send, so whether MULTI is open is unknown: start afresh.
    connection.drop()
    throw new RedisTransactionError(`Redis answered MULTI with ${String(multi)}`)
  }

  const replies: Promise<unknown>[] = []
  try {
    for (const [name, ...args] of commands) replies.push(client.send(name, args))
    replies.push(client.send('EXEC', []))
  } catch (error) {
    // EXEC was not written, which would leave MULTI open on a live connection and pull the next
    // transaction's commands into this one. Dropping the connection makes Redis discard it, and
    // the replies already sent for still get a handler, as they reject.
    connection.drop()
    for (const reply of replies) reply.catch(() => undefined)
    throw error
  }

  const queued = await Promise.all(replies)
  const exec = queued.pop()
  if (queued.some((reply) => reply !== 'QUEUED')) {
    throw new RedisTransactionError('Redis ran a transaction command without queueing it')
  }
  if (!Array.isArray(exec) || exec.length !== commands.length) {
    throw new RedisTransactionError(`Redis answered EXEC with ${Array.isArray(exec) ? exec.length : typeof exec} replies`)
  }
  return exec
}

// Up to this many commands share one MULTI/EXEC, so a burst never makes Redis run one huge block.
const MAX_BATCH_COMMANDS = 1000

interface QueuedTransaction {
  commands: readonly RedisCommandLine[]
  timeoutMs: number
  // Set once its batch is taken off the queue; from then on its outcome is unknown until EXEC replies.
  sent: boolean
  resolve(replies: unknown[]): void
  reject(error: unknown): void
}

// Bun 1.4.4 holds MULTI and EXEC until every earlier reply on the connection is in, and MULTI's OK
// is awaited before queueing, so a transaction costs about three round trips and transactions on
// one connection run one after another (measured: about 600 a second over a 0.6 ms link).
// Transactions that arrive while one is in flight therefore go out together as the next MULTI/EXEC,
// each still atomic (the batch is), and each caller gets its own slice of EXEC's replies. One
// command Redis refuses to queue aborts its whole batch.
function transactionQueue(connection: Connection) {
  const waiting: QueuedTransaction[] = []
  let draining = false

  function takeBatch(): QueuedTransaction[] {
    let commands = 0
    let size = 0
    for (const queued of waiting) {
      if (size > 0 && commands + queued.commands.length > MAX_BATCH_COMMANDS) break
      commands += queued.commands.length
      size++
    }
    const batch = waiting.splice(0, size)
    for (const queued of batch) queued.sent = true
    return batch
  }

  // One batch in flight at a time, each under a deadline (its longest caller's), so the loop always
  // moves on.
  async function drain(): Promise<void> {
    while (waiting.length > 0) {
      const batch = takeBatch()
      try {
        const replies = await withDeadline(
          connection,
          (client) => runTransaction(client, connection, batch.flatMap((queued) => queued.commands)),
          Math.max(...batch.map((queued) => queued.timeoutMs)),
        )
        let offset = 0
        for (const queued of batch) {
          queued.resolve(replies.slice(offset, offset + queued.commands.length))
          offset += queued.commands.length
        }
      } catch (error) {
        for (const queued of batch) queued.reject(error)
      }
    }
    draining = false
  }

  return function enqueue(commands: readonly RedisCommandLine[], timeoutMs: number): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const queued: QueuedTransaction = {
        commands,
        timeoutMs,
        sent: false,
        resolve(replies) {
          clearTimeout(timer)
          resolve(replies)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        // Still queued: it never ran, and leaves the queue. Sent: EXEC may have run, and the
        // connection is dropped as for a command, which fails the rest of its batch too.
        if (queued.sent) connection.drop()
        else waiting.splice(waiting.indexOf(queued), 1)
        reject(new RedisTimeoutError(timeoutMs))
      }, timeoutMs)
      waiting.push(queued)
      if (!draining) {
        draining = true
        // A microtask later, so every transaction started in this tick joins the first batch.
        queueMicrotask(() => void drain())
      }
    })
  }
}

export function createRedis(url: string): Redis {
  let closed = false
  const isClosed = () => closed
  const shared = lazyConnection(url, isClosed)
  // A connection of its own, opened by the first transaction: a MULTI on the shared connection would
  // queue other callers' concurrent commands (and PINGs) into it, and they would get QUEUED back.
  const transactions = lazyConnection(url, isClosed)
  const enqueueTransaction = transactionQueue(transactions)

  function command<T>(run: (redis: RedisClient) => Promise<T>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    return withDeadline(shared, run, timeoutMs)
  }

  return {
    command,

    transaction(commands, timeoutMs = COMMAND_TIMEOUT_MS) {
      return enqueueTransaction(commands, timeoutMs)
    },

    async probe(timeoutMs = PROBE_TIMEOUT_MS) {
      try {
        // PING changes nothing, so a lost connection is retried within the same deadline: a Redis
        // that is up is not reported down just because it closed the shared connection a moment ago.
        const reply = await withDeadline(shared, (redis) => redis.ping(), timeoutMs, { retryLostConnection: true })
        return reply === 'PONG' ? 'up' : 'down'
      } catch {
        return 'down'
      }
    },

    close() {
      closed = true
      shared.drop()
      transactions.drop()
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
