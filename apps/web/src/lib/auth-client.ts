import { createAuthClient } from 'better-auth/react'
import { apiOrigin } from './api-origin'

// The only way to talk to `/api/auth/*` (apps/web R14). Better Auth appends its default base path
// `/api/auth`, which is where the API mounts it. Plugins (admin, access control from @repo/auth) are added
// with the auth feature (TASK-09). Unlike `./api`, it does not forward the visitor's cookie during SSR yet, so a
// server-side session lookup needs `fetchOptions.headers` (the cookie from `getRequestHeader`) first.
export const authClient = createAuthClient({ baseURL: apiOrigin() })
