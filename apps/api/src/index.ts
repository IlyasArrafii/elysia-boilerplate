import { app } from './app'
import { env } from './env'
import { telemetry } from './utils/telemetry'

app.listen(env.PORT)
telemetry.emit('app.started', { version: env.APP_VERSION, env: env.NODE_ENV })
