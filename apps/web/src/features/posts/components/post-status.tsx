import type { PostStatus } from '../lib/types'

// The status written out, never shown by colour alone (DESIGN.md §12).
export function PostStatusLabel({ status }: Readonly<{ status: PostStatus }>) {
  return (
    <span className={status === 'published' ? 'font-mono text-mono text-success' : 'font-mono text-mono text-muted'}>
      {status}
    </span>
  )
}
