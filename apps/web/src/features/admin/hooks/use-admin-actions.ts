import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { recheckSession } from '@/features/auth'
import { authClient } from '@/lib/auth-client'
import { callAdmin, localError, SESSION_NOT_FOUND, USER_CHANGED } from '../lib/errors'
import { adminKeys } from '../lib/keys'
import { sameRoles, type AdminUser } from '../lib/users'
import { toBanBody, type BanInput } from '../lib/validation'
import type { RoleName } from './use-roles'
import { fetchUser } from './use-users'
import { sessionToken } from './use-user-sessions'

// Role, ban and unban first re-read the target and refuse when the field the confirmation was about (the roles it
// showed, or whether the user is banned) no longer matches; one session's revocation first checks it still exists.
// That narrows the window for acting on a stale screen but cannot close it: the API decides on what it holds then.
// Variables hold IDs and what the confirmation showed, never a session token. A 401 or 403 needs nothing here:
// `installAuthFailureReactions` re-reads the signed-in admin's session or permissions for every mutation.

async function freshUser(queryClient: QueryClient, userId: string): Promise<AdminUser> {
  const user = await fetchUser(userId)
  queryClient.setQueryData(adminKeys.user(user.id), user)
  return user
}

// After a change, or a refusal (which often means the screen was out of date): the user's list rows, detail and
// sessions are read again.
async function refreshUser(queryClient: QueryClient, userId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: adminKeys.users() }),
    queryClient.invalidateQueries({ queryKey: adminKeys.sessions(userId) }),
  ])
}

export interface SetRoleInput {
  userId: string
  // The roles the confirmation showed as current.
  expectedRoles: readonly string[]
  role: RoleName
}

// POST /api/auth/admin/set-role (`user:set-role`). Own role changes never reach here (the UI blocks them, and the
// API answers `CANNOT_CHANGE_OWN_ROLE`).
export function useSetRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, expectedRoles, role }: SetRoleInput) => {
      const fresh = await freshUser(queryClient, userId)
      if (!sameRoles(fresh.roles, expectedRoles)) throw localError(409, USER_CHANGED)
      await callAdmin(() => authClient.admin.setRole({ userId, role }))
    },
    onSettled: (_data, _error, { userId }) => refreshUser(queryClient, userId),
  })
}

export interface BanUserInput {
  userId: string
  ban: BanInput
}

// POST /api/auth/admin/ban-user (`user:ban`). The API also deletes every session of the user.
export function useBanUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, ban }: BanUserInput) => {
      const fresh = await freshUser(queryClient, userId)
      if (fresh.banned) throw localError(409, USER_CHANGED)
      await callAdmin(() => authClient.admin.banUser({ userId, ...toBanBody(ban) }))
    },
    onSettled: (_data, _error, { userId }) => refreshUser(queryClient, userId),
  })
}

// POST /api/auth/admin/unban-user (`user:ban`).
export function useUnbanUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      const fresh = await freshUser(queryClient, userId)
      if (!fresh.banned) throw localError(409, USER_CHANGED)
      await callAdmin(() => authClient.admin.unbanUser({ userId }))
    },
    onSettled: (_data, _error, { userId }) => refreshUser(queryClient, userId),
  })
}

export interface RevokeSessionInput {
  userId: string
  sessionId: string
}

// POST /api/auth/admin/revoke-user-session (`session:revoke`). Better Auth answers success for a token that is
// already gone, so the session is looked up first and a missing one is reported, not shown as revoked.
export function useRevokeSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, sessionId }: RevokeSessionInput) => {
      const token = await sessionToken(userId, sessionId)
      if (token === null) throw localError(404, SESSION_NOT_FOUND)
      await callAdmin(() => authClient.admin.revokeUserSession({ sessionToken: token }))
    },
    // The revoked session may be this tab's own.
    onSuccess: () => recheckSession(queryClient),
    onSettled: (_data, _error, { userId }) => refreshUser(queryClient, userId),
  })
}

// POST /api/auth/admin/revoke-user-sessions (`session:revoke`). No read first: it ends whatever sessions the user has
// when the API runs it, which may differ from the count the confirmation showed. On one's own account this signs this
// tab out too; re-checking the session lets the session watcher send the admin to /login.
export function useRevokeAllSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      await callAdmin(() => authClient.admin.revokeUserSessions({ userId }))
    },
    onSuccess: () => recheckSession(queryClient),
    onSettled: (_data, _error, { userId }) => refreshUser(queryClient, userId),
  })
}
