import { createLink } from '@tanstack/react-router'
import type { ComponentProps } from 'react'

// An inline link in running text: the accent colour plus an underline, so it is not told apart by colour alone.
function Anchor(props: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      className="rounded-sm text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    />
  )
}

export const TextLink = createLink(Anchor)
