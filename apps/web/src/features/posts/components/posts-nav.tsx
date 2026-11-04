import { NavLink } from '@/components/nav-link'
import { usePermissions } from '@/features/auth'

// The header link to the posts pages, shown only to a visitor whose role grants `posts:read` (DESIGN.md §11:
// forbidden pages are not shown in navigation). Hidden while permissions load or after they fail to load.
export function PostsNav() {
  const { can } = usePermissions()
  if (!can('posts:read')) return null
  return <NavLink to="/posts">Posts</NavLink>
}
