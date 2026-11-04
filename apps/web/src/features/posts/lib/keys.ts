// Query key factory (apps/web R10). Lists and details are separate branches, so a write can invalidate every list
// page at once without touching the details, and the other way round.
export const postsKeys = {
  all: ['posts'] as const,
  lists: () => [...postsKeys.all, 'list'] as const,
  list: (page: number, limit: number) => [...postsKeys.lists(), { page, limit }] as const,
  details: () => [...postsKeys.all, 'detail'] as const,
  detail: (id: string) => [...postsKeys.details(), id] as const,
}
