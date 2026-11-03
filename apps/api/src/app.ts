import { Elysia } from 'elysia'
import { health } from './modules/health'
import { errorHandler } from './utils/error'
import { loggerPlugin } from './utils/logger/plugin'
import { mountModule } from './utils/logger/module'

// The root app. It never listens: `index.ts` does, and tests call `app.handle(new Request(...))`.
// `/api` is written only here (apps/api R1).
export const app = new Elysia({ prefix: '/api' })
  .use(loggerPlugin)
  .use(errorHandler)
  .use(mountModule(health))

export type App = typeof app
