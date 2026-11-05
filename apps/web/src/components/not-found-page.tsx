import { buttonVariants, cn } from '@repo/ui'
import { Link } from '@tanstack/react-router'

// Shown for any URL that matches no route. It replaces the app shell, so it carries its own way back home.
// `enabled:hover` in the button styles never matches an <a>, so the link gets its own hover.
export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8 md:px-8">
      <h1 className="text-h1 text-primary">Page not found</h1>
      <p className="mt-3 text-body text-muted">There is no page at this address.</p>
      <Link to="/" className={cn(buttonVariants(), 'mt-6 hover:bg-hover')}>
        Go to the home page
      </Link>
    </main>
  )
}
