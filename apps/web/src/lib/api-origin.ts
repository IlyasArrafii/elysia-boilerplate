import { createIsomorphicFn } from '@tanstack/react-start'

// Where the API lives, as an origin (the `/api` prefix is part of every route).
// - SSR: straight to the API at API_INTERNAL_URL (apps/web R13). In dev, vite.config.ts fills it from the
//   repo-root .env; in production it comes from the real environment.
// - Browser: the page's own origin; `/api` is proxied (DEC-020). The server branch is compiled out of the
//   client bundle, so browser code never contains an absolute API URL.
export const apiOrigin = createIsomorphicFn()
  .server(() => {
    const url = process.env.API_INTERNAL_URL
    if (!url) throw new Error('API_INTERNAL_URL is not set: SSR cannot reach the API')
    return url
  })
  .client(() => window.location.origin)
