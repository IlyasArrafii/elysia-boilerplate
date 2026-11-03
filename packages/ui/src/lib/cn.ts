import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Our type scale (DESIGN.md §5) uses names, not t-shirt sizes. Without this, tailwind-merge reads
// `text-body` as a colour and drops it when `text-fg` follows.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['h1', 'h2', 'h3', 'body', 'caption', 'mono'] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
