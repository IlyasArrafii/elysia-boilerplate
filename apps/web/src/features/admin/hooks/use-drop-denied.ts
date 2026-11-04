import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { usePermissions } from '@/features/auth'
import { deniedAdminKeys } from '../lib/guards'

// Once the API has confirmed the signed-in user's current permissions, cached admin data they can no longer read is
// removed (a demotion seen through a 403, a role change from another tab). Runs on every admin page.
export function useDropDeniedAdminData() {
  const queryClient = useQueryClient()
  const { status, can } = usePermissions()
  useEffect(() => {
    if (status !== 'ready') return
    for (const queryKey of deniedAdminKeys(can)) queryClient.removeQueries({ queryKey })
  }, [status, can, queryClient])
}
