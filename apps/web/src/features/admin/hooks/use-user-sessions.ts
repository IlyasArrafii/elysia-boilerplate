import { queryOptions, useQuery } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { callAdmin, localError } from '../lib/errors'
import { adminKeys } from '../lib/keys'
import { toAdminSessions, type AdminSession } from '../lib/sessions'

export async function fetchUserSessions(userId: string): Promise<AdminSession[]> {
  return toAdminSessions(await callAdmin(() => authClient.admin.listUserSessions({ userId })))
}

// The token of one current session, read just before revoking it and kept nowhere: not in a query, not in a
// mutation's variables. Null when the session is no longer among the user's sessions. The API sends tokens only to
// a caller holding `session:revoke`, so a listed session without one means the role lost that permission: a 403.
export async function sessionToken(userId: string, sessionId: string): Promise<string | null> {
  const { sessions } = await callAdmin(() => authClient.admin.listUserSessions({ userId }))
  const session = sessions.find((entry) => entry.id === sessionId)
  if (!session) return null
  if (session.token === undefined) throw localError(403, 'FORBIDDEN')
  return session.token
}

// POST /api/auth/admin/list-user-sessions (`session:list`). Tokens are dropped before caching (`toAdminSession`).
// The query still stays out of loaders: the session list is browser-only data on this screen.
export function userSessionsQueryOptions(userId: string) {
  return queryOptions({ queryKey: adminKeys.sessions(userId), queryFn: () => fetchUserSessions(userId) })
}

export function useUserSessions(userId: string, enabled: boolean) {
  return useQuery({ ...userSessionsQueryOptions(userId), enabled })
}
