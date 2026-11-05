import { Button } from '@repo/ui'
import type { ReactNode } from 'react'
import { ErrorAlert } from '@/components/error-alert'
import { isForbidden, permissionsErrorView, postsErrorView, type PostsAction } from '../lib/errors'
import { TextLink } from './links'

// The page shell every posts page shares (DESIGN.md §6: 24px/32px content margin).
export function PostsMain({ children }: Readonly<{ children: ReactNode }>) {
  return <main className="mx-auto max-w-5xl px-6 py-8 md:px-8">{children}</main>
}

export function BackToPosts() {
  return <TextLink to="/posts">All posts</TextLink>
}

// The post id in the address is not a post (404 POST_NOT_FOUND, or not an id at all): deleted, or a wrong link.
export function MissingPost({ error }: Readonly<{ error: unknown }>) {
  const view = postsErrorView(error, 'read')
  return (
    <PostsMain>
      <BackToPosts />
      <h1 className="mt-4 text-h1 text-primary">Post not found</h1>
      <p className="mt-3 border-y border-border py-3">
        <span className="font-mono text-mono text-muted">{view.code}</span>
        <span className="ml-3">This post does not exist. It may have been deleted, or the link is wrong.</span>
      </p>
    </PostsMain>
  )
}

// A failed read. 403 gets no "Try again": the same role would get the same answer.
export function LoadError({ error, action, onRetry }: Readonly<{ error: unknown; action: PostsAction; onRetry: () => void }>) {
  return (
    <ErrorAlert error={postsErrorView(error, action)}>
      {!isForbidden(error) && <Button onClick={onRetry}>Try again</Button>}
    </ErrorAlert>
  )
}

// Permissions failed to load: every write is hidden (fail closed) and this says why.
export function PermissionsUnavailable({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => void }>) {
  return (
    <ErrorAlert error={permissionsErrorView(error)}>
      <Button onClick={onRetry}>Try again</Button>
    </ErrorAlert>
  )
}

// Skeletons shaped like the content (DESIGN.md §11), never a spinner.
export function RowsSkeleton({ label, rows = 5 }: Readonly<{ label: string; rows?: number }>) {
  return (
    <div aria-busy="true" aria-label={label} className="grid gap-3">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="h-9 animate-pulse bg-hover" />
      ))}
    </div>
  )
}

export function FormSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <div aria-busy="true" aria-label={label} className="grid gap-4">
      <div className="h-11 animate-pulse bg-hover" />
      <div className="h-48 animate-pulse bg-hover" />
      <div className="h-11 w-48 animate-pulse bg-hover" />
    </div>
  )
}
