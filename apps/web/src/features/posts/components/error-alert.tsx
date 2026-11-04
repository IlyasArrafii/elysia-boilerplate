import type { ReactNode } from 'react'
import type { PostsErrorView } from '../lib/errors'

// DESIGN.md §11: an inline alert with the code in monospace, a message and, where it helps, an action.
export function ErrorAlert({ error, children }: Readonly<{ error: PostsErrorView; children?: ReactNode }>) {
  return (
    <div role="alert" className="flex flex-wrap items-start justify-between gap-3 border border-danger px-4 py-3">
      <div className="min-w-0">
        <p className="font-mono text-mono break-all text-danger">{error.code}</p>
        <p className="mt-1">{error.message}</p>
      </div>
      {children}
    </div>
  )
}
