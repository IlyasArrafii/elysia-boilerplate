import { createFileRoute } from '@tanstack/react-router'
import { HealthPage, healthQueryOptions } from '@/features/health'

export const Route = createFileRoute('/')({
  // Runs during SSR on the first load. `prefetchQuery` never throws, and SSR never renders the error state: if the
  // API is down, the server HTML shows the loading state (a failed query is not dehydrated, and the component retries
  // it on mount instead of showing the error). The browser then fetches /api/health itself and shows the error state
  // only if that fails too. Fine for this public page; a loader guarding access must not swallow errors.
  loader: ({ context }) => context.queryClient.prefetchQuery(healthQueryOptions),
  component: HealthPage,
})
