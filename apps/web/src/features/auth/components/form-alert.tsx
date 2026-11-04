import type { ReactNode } from 'react'
import type { AuthErrorView } from '../lib/errors'

// DESIGN.md §11: an inline alert with the code in monospace and a message. `role="alert"` announces it.
export function FormAlert({ error, children }: Readonly<{ error: AuthErrorView; children?: ReactNode }>) {
  return (
    <div role="alert" className="flex flex-wrap items-start justify-between gap-3 border border-danger px-4 py-3">
      <div>
        <p className="font-mono text-mono break-all text-danger">{error.code}</p>
        <p className="mt-1">{error.message}</p>
      </div>
      {children}
    </div>
  )
}
