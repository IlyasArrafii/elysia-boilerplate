import { buttonVariants, cn } from '@repo/ui'
import { createLink } from '@tanstack/react-router'
import type { ComponentProps } from 'react'

// An inline link in running text: the accent colour plus an underline, so it is not told apart by colour alone.
function TextAnchor({ className, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      className={cn(
        'rounded-sm text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    />
  )
}

// A link that navigates but reads as a secondary button (DESIGN.md §9), e.g. "Edit". The variant's hover is scoped to
// `enabled:`, which an anchor never matches, so it is repeated here.
function ButtonAnchor({ className, ...props }: ComponentProps<'a'>) {
  return <a {...props} className={cn(buttonVariants({ variant: 'secondary' }), 'hover:bg-hover', className)} />
}

export const TextLink = createLink(TextAnchor)
export const ButtonLink = createLink(ButtonAnchor)
