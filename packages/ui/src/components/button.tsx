import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

// Action hierarchy and states from DESIGN.md §9; 44px minimum touch target (§12).
export const buttonVariants = cva(
  'inline-flex min-h-11 enabled:cursor-pointer items-center justify-center gap-2 rounded-sm px-4 text-body font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-surface enabled:hover:bg-secondary',
        accent: 'bg-accent text-surface enabled:hover:bg-primary',
        secondary: 'border border-border bg-surface text-fg enabled:hover:bg-hover',
        ghost: 'text-fg enabled:hover:bg-hover',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>

// `type` defaults to "button" so a button inside a form never submits it by accident.
export function Button({ className, variant, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
}
