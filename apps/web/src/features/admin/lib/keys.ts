import type { UsersSearch } from './users'

// Query key factory (apps/web R10). Every key starts with `admin`, so one invalidation reaches the whole feature.
export const adminKeys = {
  all: ['admin'] as const,
  users: () => [...adminKeys.all, 'users'] as const,
  userList: (search: UsersSearch) => [...adminKeys.users(), 'list', search] as const,
  userDetails: () => [...adminKeys.users(), 'detail'] as const,
  user: (userId: string) => [...adminKeys.userDetails(), userId] as const,
  allSessions: () => [...adminKeys.all, 'sessions'] as const,
  sessions: (userId: string) => [...adminKeys.allSessions(), userId] as const,
  roles: () => [...adminKeys.all, 'roles'] as const,
}
