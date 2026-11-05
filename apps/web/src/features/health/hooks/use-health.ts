import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { unwrap } from '@/lib/api-error'
import { healthKeys } from '../lib/keys'

// Shared by the route loader (runs during SSR) and the hook (refetches from the browser).
export const healthQueryOptions = queryOptions({
  queryKey: healthKeys.status(),
  queryFn: () => unwrap(api.health.get()),
})

export function useHealth() {
  return useQuery(healthQueryOptions)
}
