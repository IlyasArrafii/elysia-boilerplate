import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { watchSession } from '../lib/watch'

// Mounted once in the app shell. Effects never run during SSR, so the watcher lives in the browser only.
export function useSessionWatch() {
  const queryClient = useQueryClient()
  const router = useRouter()
  useEffect(() => watchSession(queryClient, router), [queryClient, router])
}
