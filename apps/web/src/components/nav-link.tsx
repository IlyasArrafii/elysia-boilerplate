import { cn } from '@repo/ui'
import { createLink } from '@tanstack/react-router'
import type { ComponentProps } from 'react'

// A header link: 44px tall (DESIGN.md §12). The current page gets an accent underline and bold text, so it is not
// marked by colour alone; TanStack Router sets `aria-current="page"` on the active link.
function NavAnchor({ className, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      className={cn(
        'inline-flex min-h-11 items-center rounded-sm border-b-2 border-transparent px-2 text-body text-fg hover:bg-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'aria-[current=page]:border-accent aria-[current=page]:font-semibold',
        className,
      )}
    />
  )
}

export const NavLink = createLink(NavAnchor)
