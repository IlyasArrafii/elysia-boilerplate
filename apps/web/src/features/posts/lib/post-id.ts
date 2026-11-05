import { notFound } from '@tanstack/react-router'

// Post ids are UUIDs (the API's `t.String({ format: 'uuid' })`). The router decodes path params, so `/posts/..%2Fme`
// gives `postId = '../me'`, and Eden puts a path param into the URL as is: anything else must never reach the API.
const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// For the `/posts/$postId` routes' `beforeLoad`: an id that cannot be a post is the not-found page, with no API call.
export function requirePostId(postId: string): void {
  if (!POST_ID.test(postId)) throw notFound()
}
