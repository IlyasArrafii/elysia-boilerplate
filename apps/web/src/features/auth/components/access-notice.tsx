import { useRouterState } from '@tanstack/react-router'
import { FORBIDDEN_NOTICE } from '../lib/guards'

// The short message after `requirePermission` sent the visitor to / (DESIGN.md §11, forbidden state). It reads the
// raw query string, so it works on any page without that page declaring the param.
export function AccessNotice() {
  const notice = useRouterState({ select: (state) => new URLSearchParams(state.location.searchStr).get('notice') })
  if (notice !== FORBIDDEN_NOTICE) return null
  return (
    <div role="status" className="mx-auto mt-4 max-w-5xl px-6 md:px-8">
      <p className="border border-warning px-4 py-3">
        <span className="font-mono text-mono text-warning">FORBIDDEN</span>
        <span className="ml-3">Your role does not allow that page, so you were brought here.</span>
      </p>
    </div>
  )
}
