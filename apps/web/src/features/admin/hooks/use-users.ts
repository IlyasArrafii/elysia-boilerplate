import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { callAdmin, localError, USER_NOT_FOUND } from '../lib/errors'
import { adminKeys } from '../lib/keys'
import { listUsersQuery, toAdminUser, toUsersPage, userByIdQuery, type AdminUser, type UsersSearch } from '../lib/users'

// GET /api/auth/admin/list-users (`user:list`). Better Auth 1.7.15 answers an empty list instead of an error when
// its database query fails, so an empty page can also mean that; nothing on the client can tell the two apart.
export function usersQueryOptions(search: UsersSearch) {
  return queryOptions({
    queryKey: adminKeys.userList(search),
    queryFn: async () => {
      const data = await callAdmin(() => authClient.admin.listUsers({ query: listUsersQuery(search) }))
      return toUsersPage(data, search.page ?? 1)
    },
  })
}

// Paging keeps the previous page on screen until the next one arrives, instead of flashing the skeleton.
export function useUsers(search: UsersSearch) {
  return useQuery({ ...usersQueryOptions(search), placeholderData: keepPreviousData })
}

// Always a fresh read: the detail query uses it, and role, ban and unban re-read their target with it first.
export async function fetchUser(userId: string): Promise<AdminUser> {
  const data = await callAdmin(() => authClient.admin.listUsers({ query: userByIdQuery(userId) }))
  const user = data.users.find((candidate) => candidate.id === userId)
  if (!user) throw localError(404, USER_NOT_FOUND)
  return toAdminUser(user)
}

export function userQueryOptions(userId: string) {
  return queryOptions({ queryKey: adminKeys.user(userId), queryFn: () => fetchUser(userId) })
}

export function useUser(userId: string, enabled: boolean) {
  return useQuery({ ...userQueryOptions(userId), enabled })
}
