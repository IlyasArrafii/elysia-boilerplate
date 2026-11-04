// Users as the admin screens see them, mapped from the Better Auth admin plugin's output (1.7.15 `UserWithRole`).

export const USERS_PAGE_SIZE = 20

// The `?page=&q=` of /admin/users. `q` searches emails (Better Auth's default search field, `contains`).
export interface UsersSearch {
  page?: number
  q?: string
}

export interface AdminUser {
  id: string
  email: string
  name: string
  // The stored role read exactly like Better Auth reads it (see `rolesOf`).
  roles: string[]
  banned: boolean
  // Shown to admins only. Never logged (auth/README.md §6).
  banReason: string | null
  // ISO 8601; null for a ban without an end.
  banExpires: string | null
  createdAt: string
}

export interface UsersPage {
  users: AdminUser[]
  total: number
  page: number
  totalPages: number
}

export interface RawAdminUser {
  id: string
  email: string
  name: string
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  banExpires?: Date | string | null
  createdAt: Date | string
}

const DEFAULT_ROLE = 'user'

// Better Auth 1.7.15 (`hasPermission`): an empty value is the default role, anything else is split on commas and
// nothing is trimmed. Kept identical so the screen shows the roles the API actually checks.
export function rolesOf(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined || stored === '') return [DEFAULT_ROLE]
  return stored.split(',')
}

// The client may hand dates back as `Date` or as the JSON string; queries hold strings so SSR can serialise them.
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function toAdminUser(raw: RawAdminUser): AdminUser {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    roles: rolesOf(raw.role),
    banned: raw.banned === true,
    banReason: raw.banned === true ? (raw.banReason ?? null) : null,
    banExpires: raw.banned === true ? toIso(raw.banExpires) : null,
    createdAt: toIso(raw.createdAt) ?? '',
  }
}

export function toUsersPage(raw: { users: RawAdminUser[]; total: number }, page: number): UsersPage {
  return {
    users: raw.users.map(toAdminUser),
    total: raw.total,
    page,
    totalPages: Math.max(1, Math.ceil(raw.total / USERS_PAGE_SIZE)),
  }
}

// `validateSearch` of /admin/users: anything that is not a positive whole page number or a non-empty search is left
// out, so a hand-edited URL shows page 1 instead of an error.
export function validateUsersSearch(search: Record<string, unknown>): UsersSearch {
  const result: UsersSearch = {}
  const page = typeof search.page === 'string' ? Number(search.page) : search.page
  if (typeof page === 'number' && Number.isSafeInteger(page) && page > 1) result.page = page
  if (typeof search.q === 'string' && search.q.trim() !== '') result.q = search.q.trim()
  return result
}

// The `list-users` query for one page, newest accounts first.
export function listUsersQuery(search: UsersSearch) {
  const page = search.page ?? 1
  return {
    limit: USERS_PAGE_SIZE,
    offset: (page - 1) * USERS_PAGE_SIZE,
    sortBy: 'createdAt',
    sortDirection: 'desc' as const,
    ...(search.q === undefined ? {} : { searchValue: search.q, searchField: 'email' as const, searchOperator: 'contains' as const }),
  }
}

// One user. `get-user` is blocked by the API's allowlist (API.md §3.1), so the detail reads `list-users` filtered on
// the id, which `user:list` allows.
export function userByIdQuery(userId: string) {
  return { filterField: 'id', filterValue: userId, filterOperator: 'eq' as const, limit: 1 }
}

// Deterministic on server and client (no locale or time zone of the machine), so SSR HTML matches hydration.
export function formatDateTime(iso: string | null): string {
  if (iso === null || iso === '') return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index])
}
