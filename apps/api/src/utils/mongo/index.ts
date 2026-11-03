import { MongoBulkWriteError, MongoClient, type Collection, type Document } from 'mongodb'
import { env } from '../../env'

export type { Collection, Document, IndexDescription, ObjectId } from 'mongodb'

// The log store (log-storage.md §2). MongoDB holds logs only; PostgreSQL holds app data.
export const LOG_COLLECTION = 'log_event'

export type LogStoreStatus = 'up' | 'down' | 'disabled'

const DUPLICATE_KEY = 11000
const DEFAULT_PROBE_TIMEOUT_MS = 1000
// The driver defaults are 30 s for server selection and connect, and no limit at all for a
// socket read or a pool wait, so one stalled server reply could hold the sink's single write
// slot forever. Every stage gets a finite limit; stdout already has every line.
const DEFAULT_TIMEOUTS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10_000,
  waitQueueTimeoutMS: 5000,
}

export interface LogStoreOptions {
  url: string
  dbName: string
  // Shows in the server logs and `currentOp`, so an operator can tell the API from a script.
  appName: string
  serverSelectionTimeoutMS?: number
  connectTimeoutMS?: number
  // 0 means no limit (driver default); only the operator scripts use it.
  socketTimeoutMS?: number
}

export interface LogStore {
  readonly collection: Collection<Document>
  // Throws when any document could not be stored.
  insert(documents: Document[]): Promise<void>
  probe(timeoutMs?: number): Promise<'up' | 'down'>
  close(): Promise<void>
}

// The driver sets `_id` on each document before sending it, so retrying a batch that was partly
// written reports the stored documents as duplicate keys. Those are not failures. When a bulk
// write has write errors, the driver throws for those and a write-concern error is only on
// `result` (driver 7.8.0 bulk/common.ts), so it must be read there.
export function onlyDuplicateKeys(error: unknown): boolean {
  if (!(error instanceof MongoBulkWriteError)) return false
  if (error.writeConcernError !== undefined || error.result.getWriteConcernError() !== undefined) return false
  const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors]
  return writeErrors.length > 0 && writeErrors.every((writeError) => writeError.code === DUPLICATE_KEY)
}

// The driver connects on the first operation, so creating a store does no I/O and an
// unreachable server never blocks startup (log-storage.md §3).
export function createLogStore(options: LogStoreOptions): LogStore {
  const client = new MongoClient(options.url, {
    appName: options.appName,
    waitQueueTimeoutMS: DEFAULT_TIMEOUTS.waitQueueTimeoutMS,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? DEFAULT_TIMEOUTS.serverSelectionTimeoutMS,
    connectTimeoutMS: options.connectTimeoutMS ?? DEFAULT_TIMEOUTS.connectTimeoutMS,
    socketTimeoutMS: options.socketTimeoutMS ?? DEFAULT_TIMEOUTS.socketTimeoutMS,
  })
  const db = client.db(options.dbName)
  const collection = db.collection(LOG_COLLECTION)

  // The probe's timer does not cancel the ping, so a frequent health check against a stalled
  // server would pile up pings. Callers share the one in flight until it settles.
  let pendingPing: Promise<'up' | 'down'> | undefined
  const ping = (): Promise<'up' | 'down'> => {
    pendingPing ??= db
      .command({ ping: 1 })
      .then(
        () => 'up' as const,
        () => 'down' as const,
      )
      .finally(() => {
        pendingPing = undefined
      })
    return pendingPing
  }

  return {
    collection,

    async insert(documents) {
      try {
        // w: 1, logs are not worth waiting on a majority.
        await collection.insertMany(documents, { ordered: false, writeConcern: { w: 1 } })
      } catch (error) {
        if (!onlyDuplicateKeys(error)) throw error
      }
    },

    // `ping` needs no privilege, so it works with the insert-only writer. Driver 7 has no
    // per-operation timeout (`timeoutMS` is deprecated and ignored), hence the race.
    async probe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'down'>((resolve) => {
        timer = setTimeout(() => resolve('down'), timeoutMs)
      })
      try {
        return await Promise.race([ping(), timeout])
      } finally {
        clearTimeout(timer)
      }
    },

    async close() {
      await client.close()
    },
  }
}

// The API process's store: the writer user only. Null when LOG_MONGO_URL is empty (sink off).
export const logStore: LogStore | null =
  env.LOG_MONGO_URL === undefined
    ? null
    : createLogStore({ url: env.LOG_MONGO_URL, dbName: env.LOG_MONGO_DB, appName: 'api' })

// For `GET /api/health` (TASK-13). Never throws; `disabled` when the sink is off.
export async function probeLogStore(
  store: LogStore | null = logStore,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LogStoreStatus> {
  return store === null ? 'disabled' : store.probe(timeoutMs)
}

// Shutdown, after `telemetry.flush()` and `telemetry.close()` (log-storage.md §3).
export async function closeLogStore(store: LogStore | null = logStore): Promise<void> {
  await store?.close()
}
