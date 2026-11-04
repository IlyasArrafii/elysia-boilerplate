import { createIsomorphicFn } from '@tanstack/react-start'
import { createAuthClient } from 'better-auth/react'
import { apiOrigin } from './api-origin'
import { requestCookieBridge, type CookieBridge } from './ssr-cookies'

// During SSR the API sees a server-to-server call: the visitor's cookie is forwarded by hand and any cookie the
// API sets is passed on to the page response (apps/web R13). Both are read from the current request scope at
// call time, never captured. In the browser the cookie travels on its own (same origin), so no hooks.
const fetchHooks = createIsomorphicFn()
  .server((): Partial<CookieBridge> => requestCookieBridge(apiOrigin()))
  .client((): Partial<CookieBridge> => ({}))

// The only way to talk to `/api/auth/*` (apps/web R14). Better Auth appends its default base path `/api/auth`,
// which is where the API mounts it. No client plugins yet: the admin client arrives with the admin feature
// (TASK-17), and never with impersonation (apps/web R20).
export const authClient = createAuthClient({ baseURL: apiOrigin(), fetchOptions: fetchHooks() })
