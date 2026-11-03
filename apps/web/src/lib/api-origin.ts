import { createIsomorphicFn } from '@tanstack/react-start'
import { DEV_API_INTERNAL_URL } from './dev-api-url'

// Where the API lives, as an origin (the `/api` prefix is part of every route).
// - SSR: straight to the API at API_INTERNAL_URL (apps/web R13), from the real environment or, in dev, the
//   repo-root .env loaded by the `dev` script. Unset, dev uses the proxy's default; a production build refuses
//   to guess. `=== true` because only Vite replaces `import.meta.env.PROD` with a boolean (outside Vite, e.g.
//   `bun test`, it is an env lookup).
// - Browser: the page's own origin; `/api` is proxied (DEC-020). The server branch is compiled out of the
//   client bundle, so browser code never contains an absolute API URL.
export const apiOrigin = createIsomorphicFn()
  .server(() => {
    const url = process.env.API_INTERNAL_URL
    if (url) return url
    if (import.meta.env.PROD === true) throw new Error('API_INTERNAL_URL is not set: SSR cannot reach the API')
    return DEV_API_INTERNAL_URL
  })
  .client(() => window.location.origin)
