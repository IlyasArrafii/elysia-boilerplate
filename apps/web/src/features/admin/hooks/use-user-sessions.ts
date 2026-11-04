import { queryOptions, useQuery } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { callAdmin } from '../lib/errors'
import { adminKeys } from '../lib/keys'
import { toAdminSessions, type AdminSession } from '../lib/sessions'

export async function fetchUserSessions(userId: string): Promise<AdminSession[]> {
  return toAdminSessions(await callAdmin(() => authClient.admin.listUserSessions({ userId })))
}

// The token of one current session, read just before revoking it and kept nowhere: not in a query, not in a
// mutation's variables. Null when the session is no longer among the user's sessions.
export async function sessionToken(userId: string, sessionId: string): Promise<string | null> {
  const { sessions } = await callAdmin(() => authClient.admin.listUserSessions({ userId }))
  return sessions.find((session) => session.id === sessionId)?.token ?? null
}

// POST /api/auth/admin/list-user-sessions (`session:list`). Tokens are dropped before caching (`toAdminSession`).
// The query still stays out of loaders: the session list is browser-only data on this screen.
export function userSessionsQueryOptions(userId: string) {
  return queryOptions({ queryKey: adminKeys.sessions(userId), queryFn: () => fetchUserSessions(userId) })
}

export function useUserSessions(userId: string, enabled: boolean) {
  return useQuery({ ...userSessionsQueryOptions(userId), enabled })
}
