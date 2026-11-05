import type { ReactNode } from 'react'

// What a failure looks like to the person: the code as the API sent it and a sentence about what to do. Each feature
// writes the sentence from its own message table, never from the response.
export interface ErrorView {
  code: string
  message: string
}

// DESIGN.md §11: an inline alert with the code in monospace, a message and, where it helps, an action such as
// "Try again". `role="alert"` announces it. The one alert every feature renders.
export function ErrorAlert({ error, children }: Readonly<{ error: ErrorView; children?: ReactNode }>) {
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
