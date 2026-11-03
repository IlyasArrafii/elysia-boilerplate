// `bun run logs:setup`: creates the log store indexes (DATABASE.md §8) with the admin user.
// Idempotent: `createIndexes` with an existing, identical index does nothing. Not run at API
// startup, and no TTL index: deletion is manual (DEC-034).
import { env, readLogMongoAdminUrl } from '../src/env'
import { logger } from '../src/utils/logger'
import { createLogStore, type Collection, type Document, type IndexDescription } from '../src/utils/mongo'

export const LOG_INDEXES: readonly IndexDescription[] = [
  { key: { kind: 1, time: 1 } },
  { key: { module: 1, level: 1, time: -1 } },
  { key: { requestId: 1 }, sparse: true },
  { key: { userId: 1, time: -1 }, sparse: true },
  { key: { event: 1, time: -1 } },
]

export async function setupIndexes(collection: Collection<Document>): Promise<string[]> {
  return collection.createIndexes([...LOG_INDEXES])
}

async function main(): Promise<void> {
  // No socket limit: an index build on a large collection can take minutes, and an operator
  // watching the run can stop it.
  const store = createLogStore({
    url: readLogMongoAdminUrl(),
    dbName: env.LOG_MONGO_DB,
    appName: 'logs-setup',
    socketTimeoutMS: 0,
  })
  try {
    const indexes = await setupIndexes(store.collection)
    logger.info({ indexes }, 'log store indexes are in place')
  } finally {
    await store.close()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'logs:setup failed')
    process.exitCode = 1
  })
}
