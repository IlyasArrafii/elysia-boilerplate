import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { permissionsQueryOptions, useSession } from '@/features/auth'
import { ApiError } from '@/lib/api-error'

// A read the API refused with 403 means the cached permissions are out of date (the role changed since they were
// loaded): asking again lets `can()` hide what the user can no longer open. 401s are handled by the session watcher.
export function useForbiddenRefresh(error: unknown) {
  const queryClient = useQueryClient()
  const userId = useSession().data?.user.id
  const forbidden = error instanceof ApiError && error.status === 403
  useEffect(() => {
    if (forbidden && userId !== undefined) void queryClient.invalidateQueries({ queryKey: permissionsQueryOptions(userId).queryKey })
  }, [forbidden, queryClient, userId])
}
