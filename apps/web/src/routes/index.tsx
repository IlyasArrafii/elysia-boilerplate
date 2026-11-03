import { createFileRoute } from '@tanstack/react-router'
import { HealthPage, healthQueryOptions } from '@/features/health'

export const Route = createFileRoute('/')({
  // Runs during SSR on the first load. `prefetchQuery` never throws: if the API is down, SSR renders the loading
  // state (failed queries are neither dehydrated nor shown on mount) and the browser fetches again, showing the
  // error state only if that fails too. Fine for this public demo; a loader guarding access must not swallow errors.
  loader: ({ context }) => context.queryClient.prefetchQuery(healthQueryOptions),
  component: HealthPage,
})
