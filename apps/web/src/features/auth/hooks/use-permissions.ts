import { queryOptions, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { api } from '@/lib/api'
import { unwrap } from '@/lib/api-error'
import { authKeys } from '../lib/keys'
import { useSession } from './use-session'

type MePermissions = NonNullable<Awaited<ReturnType<typeof api.me.permissions.get>>['data']>

// `resource:action`, derived from the API's response schema, so only permissions the API declares compile.
export type Permission = MePermissions['permissions'][number]

// GET /api/me/permissions for one signed-in user. The user id is in the key only: the API answers for whoever
// the cookie belongs to.
export function permissionsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: authKeys.permissions(userId),
    queryFn: async () => unwrap(await api.me.permissions.get()),
  })
}

export type PermissionsStatus = 'signed-out' | 'loading' | 'ready' | 'unavailable'

export interface PermissionsState {
  status: PermissionsStatus
  roles: readonly string[]
  permissions: readonly Permission[]
  // UX only (apps/web R17, R18): the API checks every request itself.
  can: (permission: Permission) => boolean
  // Why the status is `unavailable` (an ApiError or AuthError, or a network failure); null otherwise.
  error: unknown
  // Asks the API again after a failure.
  retry: () => void
}

const NONE: readonly never[] = []

// `query` is whichever query decides: the session query, or the permissions query once the session is a known user.
function statusOf(query: { isPending: boolean; isError: boolean }, signedIn: boolean): PermissionsStatus {
  if (query.isError) return 'unavailable'
  if (query.isPending) return 'loading'
  return signedIn ? 'ready' : 'signed-out'
}

// What the signed-in user may do, for hiding UI the API would refuse anyway (static-roles.md §6). Fails closed:
// signed out, still loading, or the last fetch failed → `can()` is false for everything, even if an older answer
// is still cached.
export function usePermissions(): PermissionsState {
  const session = useSession()
  const userId = session.data?.user.id
  const query = useQuery({ ...permissionsQueryOptions(userId ?? ''), enabled: userId !== undefined })

  // The session decides first. A failed session check keeps the previous user in its data, but that user is no
  // longer known to be signed in, so their cached grants have no say until the session is confirmed again.
  const source = session.isError || userId === undefined ? session : query
  const status = statusOf(source, userId !== undefined)
  const data = status === 'ready' ? query.data : undefined

  const granted = useMemo(() => new Set<Permission>(data?.permissions ?? NONE), [data])
  const can = useCallback((permission: Permission) => granted.has(permission), [granted])
  const { refetch } = source
  const retry = useCallback(() => void refetch(), [refetch])
  const error = status === 'unavailable' ? source.error : null

  return { status, roles: data?.roles ?? NONE, permissions: data?.permissions ?? NONE, can, error, retry }
}
