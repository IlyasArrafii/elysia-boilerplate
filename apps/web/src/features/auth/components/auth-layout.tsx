import type { ReactNode } from 'react'

export interface AuthFact {
  // A real identifier (endpoint, limit) shown in monospace, and what it means for the person signing in.
  term: string
  detail: string
}

// DESIGN.md §6: auth is a split pane, form left, context right. Below 1024px the context follows the form, so the
// form is always the first thing on a phone.
export function AuthLayout({
  title,
  children,
  facts,
  factsLabel,
}: Readonly<{ title: string; children: ReactNode; facts: readonly AuthFact[]; factsLabel: string }>) {
  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-6 py-8 md:px-8 lg:grid-cols-12 lg:gap-4 lg:py-12">
      <section aria-labelledby="auth-title" className="lg:col-span-5">
        <h1 id="auth-title" className="text-h1 text-primary">
          {title}
        </h1>
        <div className="mt-6">{children}</div>
      </section>

      <aside aria-label={factsLabel} className="border-t border-border pt-6 lg:col-span-6 lg:col-start-7 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
        <h2 className="text-h3 text-primary">{factsLabel}</h2>
        <dl className="mt-3 divide-y divide-border border-y border-border">
          {facts.map(({ term, detail }) => (
            <div key={term} className="grid gap-1 py-3">
              <dt className="font-mono text-mono break-all text-fg">{term}</dt>
              <dd className="text-muted">{detail}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </main>
  )
}
