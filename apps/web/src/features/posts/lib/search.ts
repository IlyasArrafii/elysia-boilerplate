// The list asks for the API's default page size (API.md §3.4, `limit` default 20).
export const POSTS_PAGE_SIZE = 20
// The API accepts `page` 1–10 000 (API.md §3.4); anything else would only earn a 400.
export const MAX_PAGE = 10_000

export interface PostsSearch {
  page?: number
}

// `validateSearch` for /posts. Page 1 is the default and stays out of the URL; a value the API would reject is
// dropped instead of turned into an error page.
export function validatePostsSearch(search: Record<string, unknown>): PostsSearch {
  const raw = search.page
  const page = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isInteger(page) && page > 1 && page <= MAX_PAGE ? { page } : {}
}

export function pageOf(search: PostsSearch): number {
  return search.page ?? 1
}
