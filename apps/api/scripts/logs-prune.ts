// `bun run logs:prune`: deletes old log documents by kind, or one user's documents, with the
// admin user (log-storage.md §5). Run with `--dry-run` first. Idempotent and safe to stop and
// re-run. Never touches PostgreSQL. The API itself never deletes logs (apps/api R36).
import { parseArgs } from 'node:util'
import { env, readLogMongoAdminUrl } from '../src/env'
import { logger } from '../src/utils/logger'
import { closeLogStore, createLogStore, type Collection, type Document, type LogStore, type ObjectId } from '../src/utils/mongo'
import { telemetry, type EventPayloads, type Kind } from '../src/utils/telemetry'
import { retentionDays } from '../src/utils/telemetry/retention'

const DAY_MS = 86_400_000
const DEFAULT_BATCH = 10_000
const MAX_BATCH = 100_000
const MAX_USER_ID_LENGTH = 255
const FLUSH_TIMEOUT_MS = 5000
const KINDS = Object.keys(retentionDays) as Kind[]
// The outcome is this command's output, so it prints whatever LOG_LEVEL is; the `app.logs_pruned`
// records and other lines follow it.
const out = logger.child({}, { level: 'info' })

const USAGE = `Usage:
  bun run logs:prune [--dry-run] [--kind <kind>]... [--older-than <days> [--force]] [--batch <n>]
  bun run logs:prune --user <userId> [--dry-run] [--batch <n>]

Kinds and default periods: ${KINDS.map((kind) => `${kind} ${retentionDays[kind]}d`).join(', ')}`

export class UsageError extends Error {
  override name = 'UsageError'
}

export type PruneOptions =
  | { mode: 'age'; kinds: Kind[]; olderThanDays?: number; dryRun: boolean; batchSize: number }
  | { mode: 'user'; userId: string; dryRun: boolean; batchSize: number }

function readPositiveInteger(flag: string, raw: string | undefined, max: number): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || value < 1 || value > max) {
    throw new UsageError(`${flag} must be an integer between 1 and ${max}, got "${raw}"`)
  }
  return value
}

function readKinds(raw: string[] | undefined): Kind[] {
  if (raw === undefined || raw.length === 0) return KINDS
  const unknown = raw.filter((kind) => !KINDS.some((known) => known === kind))
  if (unknown.length > 0) {
    throw new UsageError(`--kind must be one of ${KINDS.join(', ')}, got "${unknown.join('", "')}"`)
  }
  return KINDS.filter((kind) => raw.includes(kind))
}

export function parsePruneArgs(argv: readonly string[]): PruneOptions {
  let values
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'dry-run': { type: 'boolean', default: false },
        kind: { type: 'string', multiple: true },
        'older-than': { type: 'string' },
        force: { type: 'boolean', default: false },
        batch: { type: 'string' },
        user: { type: 'string' },
      },
    }))
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }

  const dryRun = values['dry-run']
  const batchSize = readPositiveInteger('--batch', values.batch, MAX_BATCH) ?? DEFAULT_BATCH

  if (values.user !== undefined) {
    if (values.kind !== undefined || values['older-than'] !== undefined || values.force) {
      throw new UsageError('--user deletes every kind at any age; it cannot be combined with --kind, --older-than or --force')
    }
    const userId = values.user.trim()
    if (userId === '' || userId.length > MAX_USER_ID_LENGTH) {
      throw new UsageError(`--user must be a user ID of 1 to ${MAX_USER_ID_LENGTH} characters`)
    }
    return { mode: 'user', userId, dryRun, batchSize }
  }

  const kinds = readKinds(values.kind)
  const olderThanDays = readPositiveInteger('--older-than', values['older-than'], 36_500)
  if (olderThanDays !== undefined && !values.force) {
    const shortened = kinds.filter((kind) => olderThanDays < retentionDays[kind])
    if (shortened.length > 0) {
      throw new UsageError(
        `--older-than ${olderThanDays} is below the retention period of ${shortened
          .map((kind) => `${kind} (${retentionDays[kind]}d)`)
          .join(', ')}; add --force to delete them anyway`,
      )
    }
  }
  if (values.force && olderThanDays === undefined) throw new UsageError('--force only applies to --older-than')

  return olderThanDays === undefined
    ? { mode: 'age', kinds, dryRun, batchSize }
    : { mode: 'age', kinds, olderThanDays, dryRun, batchSize }
}

export type PruneFilter = { kind: Kind; time: { $lt: Date } } | { userId: string }

// What the prune needs from the collection; narrow so tests can use an in-memory fake.
export interface PruneCollection<Id = unknown> {
  count(filter: PruneFilter): Promise<number>
  findIds(filter: PruneFilter, limit: number): Promise<Id[]>
  deleteIds(ids: Id[]): Promise<number>
}

export function pruneCollection(collection: Collection<Document>): PruneCollection<ObjectId> {
  return {
    count: (filter) => collection.countDocuments(filter),
    async findIds(filter, limit) {
      const documents = await collection.find(filter, { projection: { _id: 1 }, limit }).toArray()
      return documents.map((document) => document._id)
    },
    async deleteIds(ids) {
      const result = await collection.deleteMany({ _id: { $in: ids } })
      return result.deletedCount
    },
  }
}

// Deletes in batches of `_id`s so one run never holds a long delete on the whole range.
async function deleteInBatches<Id>(collection: PruneCollection<Id>, filter: PruneFilter, batchSize: number): Promise<number> {
  let deleted = 0
  for (;;) {
    const ids = await collection.findIds(filter, batchSize)
    if (ids.length === 0) return deleted
    const removed = await collection.deleteIds(ids)
    // Nothing removed means another run got there first, or the server refused silently: stop
    // instead of finding the same IDs forever.
    if (removed === 0) return deleted
    deleted += removed
  }
}

async function apply<Id>(collection: PruneCollection<Id>, filter: PruneFilter, options: PruneOptions): Promise<number> {
  return options.dryRun ? collection.count(filter) : deleteInBatches(collection, filter, options.batchSize)
}

export type PruneResult = EventPayloads['app.logs_pruned']

export interface PruneDependencies {
  now: Date
  emit(payload: PruneResult): void
}

export async function runPrune<Id>(
  collection: PruneCollection<Id>,
  options: PruneOptions,
  { now, emit }: PruneDependencies,
): Promise<PruneResult[]> {
  const results: PruneResult[] = []
  // Recorded as soon as each part finishes, so a later kind failing never loses the record of
  // deletions already done (a re-run cannot count them again).
  const record = (result: PruneResult): void => {
    results.push(result)
    emit(result)
  }

  if (options.mode === 'user') {
    const deleted = await apply(collection, { userId: options.userId }, options)
    record({ prunedKind: 'all', deleted, erasedUserId: options.userId, dryRun: options.dryRun })
  } else {
    for (const kind of options.kinds) {
      const cutoff = new Date(now.getTime() - (options.olderThanDays ?? retentionDays[kind]) * DAY_MS)
      const deleted = await apply(collection, { kind, time: { $lt: cutoff } }, options)
      record({ prunedKind: kind, deleted, cutoff: cutoff.toISOString(), dryRun: options.dryRun })
    }
  }

  return results
}

export function describePruneResult(result: PruneResult): string {
  const documents = `${result.deleted} ${result.deleted === 1 ? 'document' : 'documents'}`
  const done = result.dryRun ? `Dry run: would delete ${documents}` : `Deleted ${documents}`
  return result.prunedKind === 'all'
    ? `${done} of user ${result.erasedUserId}`
    : `${done} of kind ${result.prunedKind} older than ${result.cutoff}`
}

async function main(): Promise<void> {
  let options: PruneOptions
  try {
    options = parsePruneArgs(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    out.error(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  // No socket limit: counting or finding in a large collection can take minutes, and an
  // operator watching the run can stop it.
  const store = createLogStore({
    url: readLogMongoAdminUrl(),
    dbName: env.LOG_MONGO_DB,
    appName: 'logs-prune',
    socketTimeoutMS: 0,
  })
  let recorded = 0
  try {
    // Each result is recorded as `app.logs_pruned` (stored too, when LOG_MONGO_URL is set) and
    // printed as an outcome line.
    await runPrune(pruneCollection(store.collection), options, {
      now: new Date(),
      emit: (payload) => {
        recorded += 1
        telemetry.emit('app.logs_pruned', payload)
        out.info(describePruneResult(payload))
      },
    })
  } finally {
    await shutdown(store, recorded)
  }
}

async function shutdown(store: LogStore, recorded: number): Promise<void> {
  // First, so a failing close cannot skip it. With LOG_MONGO_URL set, the log store holds the only
  // lasting record of what was deleted. Losing it is a warning and keeps the exit code: the
  // deletions already happened, and a re-run cannot record them again.
  const flush = await telemetry.flush(FLUSH_TIMEOUT_MS)
  if (recorded > 0 && flush !== 'flushed') {
    out.warn({ flush }, 'The prune ran, but its app.logs_pruned records may not have reached the log store')
  }
  await telemetry.close()
  // Both, even when one fails, or the other's client keeps the process alive.
  const closed = await Promise.allSettled([store.close(), closeLogStore()])
  for (const outcome of closed) if (outcome.status === 'rejected') throw outcome.reason
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    out.error({ err: error }, 'logs:prune failed')
    process.exitCode = 1
  })
}
