import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

// Text input with the states from DESIGN.md §9 and a 44px touch target (§12). An invalid field is marked with
// `aria-invalid`, which also draws the danger border; the message itself is rendered by the caller as text.
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'min-h-11 w-full rounded-sm border border-border bg-surface px-3 text-body text-fg placeholder:text-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}
