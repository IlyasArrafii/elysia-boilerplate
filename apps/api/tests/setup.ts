import { testDatabaseUrl } from './helpers/db'

// Preloaded by bunfig.toml, so it runs before any test file imports the app and `src/env.ts`.
// Values inherited from the shell or the repo-root .env point at the dev stores, so they are replaced,
// never trusted: the database is always the guarded test database, and Redis and the MongoDB log store
// are off (memory fallback, stdout only). NODE_ENV is pinned too, because an inherited `production`
// would make those empty store URLs fail startup. Tests that need a real Redis or MongoDB, or the
// production rules, use their own TEST_* URLs or a child process with an explicit environment.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = testDatabaseUrl()
process.env.REDIS_URL = ''
process.env.LOG_MONGO_URL = ''
process.env.LOG_MONGO_ADMIN_URL = ''
