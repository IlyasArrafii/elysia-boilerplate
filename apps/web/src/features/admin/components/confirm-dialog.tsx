import { Button } from '@repo/ui'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ErrorAlert, type ErrorView } from '@/components/error-alert'

interface ConfirmDialogProps {
  title: string
  // What will happen, naming the target user ID (and session ID) (DESIGN.md §9).
  children: ReactNode
  confirmLabel: string
  pendingLabel: string
  pending: boolean
  error: ErrorView | null
  // Why confirming is no longer allowed (the role changed, the target changed, ...): the button is disabled and this
  // is shown, while the error and Cancel stay available. Null when the action may still be sent.
  blocked: string | null
  onConfirm: () => void
  onCancel: () => void
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

// Confirmation for destructive admin actions (DESIGN.md §9, §12): `role="dialog"` + `aria-modal`, focus starts on
// Cancel and stays inside, Escape cancels, focus returns to the control that opened it. Rendered only while open.
export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, pending, error, blocked, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId()
  const bodyId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => opener?.focus()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!pending) onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg border border-border bg-surface p-6"
      >
        <h2 id={titleId} className="text-h2 text-primary">
          {title}
        </h2>
        <div id={bodyId} className="mt-3 grid gap-2">
          {children}
        </div>
        {error && (
          <div className="mt-4">
            <ErrorAlert error={error} />
          </div>
        )}
        {blocked && !pending && <p className="mt-4 text-warning">{blocked}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending || blocked !== null} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

// A user or session ID inside a confirmation: monospace, never truncated, so it can be checked character by character.
export function Identifier({ children }: Readonly<{ children: string }>) {
  return <code className="font-mono text-mono break-all text-fg">{children}</code>
}
