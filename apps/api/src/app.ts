import { Elysia } from 'elysia'
import { admin } from './modules/admin'
import { health } from './modules/health'
import { me } from './modules/me'
import { posts } from './modules/posts'
import { assertRouteAccess, authPlugin } from './utils/auth'
import { errorHandler } from './utils/error'
import { loggerPlugin } from './utils/logger/plugin'
import { mountModule } from './utils/logger/module'

export type { Permission } from './utils/auth'

// 1 MiB. Bun.serve answers 413 to a larger body: from the Content-Length before any hook runs, or, for
// a chunked body, by stopping the read at the limit. Elysia parses the body ahead of the `permission`
// macro, so without this an anonymous caller could make it buffer Bun's default of about 128 MB.
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

// The root app. It never listens: `index.ts` does, and tests call `app.handle(new Request(...))`.
// `/api` is written only here (apps/api R1). `assertRouteAccess` fails startup on a route that is
// neither protected nor documented Public (default deny, DEC-010). `serve` is merged into every
// `app.listen`, so the body limit cannot be left out by whoever starts the server.
export const app = assertRouteAccess(
  new Elysia({ prefix: '/api', serve: { maxRequestBodySize: MAX_REQUEST_BODY_BYTES } })
    .use(loggerPlugin)
    .use(errorHandler)
    .use(mountModule(authPlugin))
    .use(mountModule(health))
    .use(mountModule(me))
    .use(mountModule(admin))
    .use(mountModule(posts)),
)

export type App = typeof app
