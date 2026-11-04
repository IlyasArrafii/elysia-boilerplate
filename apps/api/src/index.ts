import { app } from './app'
import { env } from './env'
import { reportUnknownRoles } from './utils/auth/unknown-roles'
import { db } from './utils/db'
import { installShutdown } from './utils/lifecycle'
import { telemetry } from './utils/telemetry'

app.listen(env.PORT)
// Bun's adapter sets `server` before `listen` returns.
if (app.server === null) throw new Error('The API server did not start')
installShutdown(app.server)
telemetry.emit('app.started', { version: env.APP_VERSION, env: env.NODE_ENV })
void reportUnknownRoles(db, telemetry)
