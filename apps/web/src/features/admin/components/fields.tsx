import { cn } from '@repo/ui'
import type { ComponentProps } from 'react'

// Native select and textarea with the same states as `Input` from packages/ui (DESIGN.md §9, 44px target §12).
// `packages/ui` has no select or textarea primitive yet; these stay local to the feature until one is added there.
const FIELD = cn(
  'min-h-11 w-full rounded-sm border border-border bg-surface px-3 text-body text-fg',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
)

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(FIELD, className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD, 'py-2', className)} {...props} />
}

export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-caption text-fg', className)} {...props} />
}
