// Creates the three MongoDB log users (docs/implement-boilerplate/static-role/observability/log-storage.md §2).
//
// The mongo image runs this once, as root, against MONGO_INITDB_DATABASE, and only when the data
// volume is empty. Re-running `docker compose up` on an existing volume skips it. The script is baked
// into the image (infra/mongo/Dockerfile). To apply a change (for example new passwords) to existing
// data, run `docker compose down -v` and then `docker compose up -d --build`.

const LOG_COLLECTION = 'log_event'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set to create the log users`)
  return value
}

const logDb = db.getSiblingDB(requireEnv('MONGO_INITDB_DATABASE'))
const logEvent = { db: logDb.getName(), collection: LOG_COLLECTION }

// Least privilege: each role is scoped to the one collection and holds only the listed actions.
const logUsers = [
  // API process (LOG_MONGO_URL): append events. Cannot read, delete or drop.
  { user: 'log_writer', passwordEnv: 'LOG_WRITER_PASSWORD', role: 'logWriter', actions: ['insert'] },
  // logs:setup and logs:prune scripts (LOG_MONGO_ADMIN_URL). Never used by the API process.
  { user: 'log_admin', passwordEnv: 'LOG_ADMIN_PASSWORD', role: 'logAdmin', actions: ['find', 'remove', 'createIndex'] },
  // People querying logs from mongosh or Compass.
  { user: 'log_reader', passwordEnv: 'LOG_READER_PASSWORD', role: 'logReader', actions: ['find'] },
]

for (const { user, passwordEnv, role, actions } of logUsers) {
  logDb.createRole({ role, privileges: [{ resource: logEvent, actions }], roles: [] })
  logDb.createUser({ user, pwd: requireEnv(passwordEnv), roles: [role] })
}
