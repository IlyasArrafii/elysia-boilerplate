import { createIsomorphicFn } from '@tanstack/react-start'
import { createAuthClient } from 'better-auth/react'
import { adminClient } from 'better-auth/client/plugins'
import type { Role } from 'better-auth/plugins/access'
import type { api } from './api'
import { apiOrigin } from './api-origin'
import { requestCookieBridge, type CookieBridge } from './ssr-cookies'

// During SSR the API sees a server-to-server call: the visitor's cookie is forwarded by hand and any cookie the
// API sets is passed on to the page response (apps/web R13). Both are read from the current request scope at
// call time, never captured. In the browser the cookie travels on its own (same origin), so no hooks.
const fetchHooks = createIsomorphicFn()
  .server((): Partial<CookieBridge> => requestCookieBridge(apiOrigin()))
  .client((): Partial<CookieBridge> => ({}))

// The API's role registry names, from the role catalogue's response schema (GET /api/admin/roles).
type RoleName = NonNullable<Awaited<ReturnType<typeof api.admin.roles.get>>['data']>['items'][number]['role']

// The only way to talk to `/api/auth/*` (apps/web R14). Better Auth appends its default base path `/api/auth`,
// which is where the API mounts it. The admin plugin's client gets the registry's role names as a type only, so
// `admin.setRole` accepts exactly the API's roles; no `ac`/`roles` values reach the browser (DEC-023), and the
// API alone decides what a role may do. Never used for impersonation (apps/web R20): those endpoints are 404.
export const authClient = createAuthClient({
  baseURL: apiOrigin(),
  fetchOptions: fetchHooks(),
  plugins: [adminClient<{ roles: Record<RoleName, Role> }>()],
})
