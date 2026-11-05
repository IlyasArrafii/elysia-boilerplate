import { Button } from '@repo/ui'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ErrorAlert } from '@/components/error-alert'
import { postsErrorView } from '../lib/errors'
import type { Post } from '../lib/types'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface DeletePostDialogProps {
  post: Post
  pending: boolean
  // The last failed attempt; the dialog stays open so it can be retried or cancelled.
  error: unknown
  onConfirm: () => void
  onCancel: () => void
}

// DESIGN.md §9: a destructive action is confirmed in a dialog that names its target, here the post's title and id.
// Modal (§12): focus starts on Cancel, Tab stays inside, Escape closes. The caller returns focus to its trigger.
export function DeletePostDialog({ post, pending, error, onConfirm, onCancel }: DeletePostDialogProps) {
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => cancel.current?.focus(), [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!pending) onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/80 p-4 sm:items-center">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-post-heading"
        aria-describedby="delete-post-target"
        onKeyDown={onKeyDown}
        className="grid w-full max-w-lg gap-4 border border-border bg-surface p-6"
      >
        <h2 id="delete-post-heading" className="text-h2 text-primary">
          Delete this post?
        </h2>
        <div id="delete-post-target" className="grid gap-2">
          <p className="break-words">
            <span className="font-semibold">{post.title}</span> will be deleted for everyone. This cannot be undone.
          </p>
          <p className="text-muted">
            Post ID <span className="font-mono text-mono break-all text-fg">{post.id}</span>
          </p>
        </div>
        {error != null && <ErrorAlert error={postsErrorView(error, 'delete')} />}
        <div className="flex flex-wrap justify-end gap-3">
          <Button ref={cancel} onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" className="bg-danger enabled:hover:bg-danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </div>
      </div>
    </div>
  )
}
