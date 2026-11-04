import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { unwrap } from '@/lib/api-error'
import { adminKeys } from '../lib/keys'

export type RoleCatalogue = NonNullable<Awaited<ReturnType<typeof api.admin.roles.get>>['data']>
export type CatalogueRole = RoleCatalogue['items'][number]
export type RoleName = CatalogueRole['role']

// GET /api/admin/roles (`role:read`): every registry role with its compiled permissions (API.md §3.5).
export const rolesQueryOptions = queryOptions({
  queryKey: adminKeys.roles(),
  queryFn: async () => unwrap(await api.admin.roles.get()),
})

export function useRoles(enabled = true) {
  return useQuery({ ...rolesQueryOptions, enabled })
}
