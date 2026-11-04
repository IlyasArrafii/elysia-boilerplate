import { Elysia } from 'elysia'
import { admin } from './modules/admin'
import { health } from './modules/health'
import { me } from './modules/me'
import { assertRouteAccess, authPlugin } from './utils/auth'
import { errorHandler } from './utils/error'
import { loggerPlugin } from './utils/logger/plugin'
import { mountModule } from './utils/logger/module'

export type { Permission } from './utils/auth'

// The root app. It never listens: `index.ts` does, and tests call `app.handle(new Request(...))`.
// `/api` is written only here (apps/api R1). `assertRouteAccess` fails startup on a route that is
// neither protected nor documented Public (default deny, DEC-010).
export const app = assertRouteAccess(
  new Elysia({ prefix: '/api' })
    .use(loggerPlugin)
    .use(errorHandler)
    .use(mountModule(authPlugin))
    .use(mountModule(health))
    .use(mountModule(me))
    .use(mountModule(admin)),
)

export type App = typeof app
