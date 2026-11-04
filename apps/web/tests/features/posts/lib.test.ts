import { describe, expect, test } from 'bun:test'
import { ApiError } from '@/lib/api-error'
import { canChangePost } from '@/features/posts/lib/access'
import { forbiddenView, isForbidden, isMissingPost, NETWORK_ERROR, postsErrorView } from '@/features/posts/lib/errors'
import { formatTimestamp } from '@/features/posts/lib/format'
import { postsKeys } from '@/features/posts/lib/keys'
import { MAX_PAGE, pageOf, validatePostsSearch } from '@/features/posts/lib/search'
import {
  changedValues,
  CONTENT_MIN_LENGTH,
  hasFieldErrors,
  serverFieldErrors,
  TITLE_MIN_LENGTH,
  validatePost,
  type PostValues,
} from '@/features/posts/lib/validation'

const valid: PostValues = { title: 'abc', content: '0123456789', status: 'draft' }

describe('validatePost', () => {
  test('uses the API minimums (title 3, content 10)', () => {
    expect(TITLE_MIN_LENGTH).toBe(3)
    expect(CONTENT_MIN_LENGTH).toBe(10)
  })

  test('accepts values exactly at the minimums', () => {
    expect(validatePost(valid)).toEqual({})
  })

  test('rejects one character under each minimum', () => {
    expect(validatePost({ ...valid, title: 'ab', content: '012345678' })).toEqual({
      title: 'Title must be at least 3 characters.',
      content: 'Content must be at least 10 characters.',
    })
  })

  test('asks for empty fields', () => {
    expect(validatePost({ ...valid, title: '', content: '' })).toEqual({ title: 'Enter a title.', content: 'Enter the content.' })
  })

  test('sets no maximum: the limits are per deployment and checked by the API', () => {
    expect(validatePost({ ...valid, title: 'x'.repeat(100_000), content: 'y'.repeat(1_000_000) })).toEqual({})
  })

  test('counts the value as typed, like the API (no trimming)', () => {
    expect(validatePost({ ...valid, title: '   ' })).toEqual({})
  })

  test('hasFieldErrors', () => {
    expect(hasFieldErrors({})).toBe(false)
    expect(hasFieldErrors({ title: undefined })).toBe(false)
    expect(hasFieldErrors({ content: 'x' })).toBe(true)
  })
})

describe('changedValues', () => {
  test('keeps only the fields that differ', () => {
    expect(changedValues(valid, valid)).toEqual({})
    expect(changedValues(valid, { ...valid, status: 'published' })).toEqual({ status: 'published' })
    expect(changedValues(valid, { title: 'new title', content: 'new content!', status: 'draft' })).toEqual({
      title: 'new title',
      content: 'new content!',
    })
  })
})

describe('serverFieldErrors', () => {
  const validation = (...fields: unknown[]) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', { fields })

  test('puts a 400 VALIDATION_ERROR on the fields it names', () => {
    expect(serverFieldErrors(validation({ path: '/title', rule: 'maxLength' }, { path: '/content', rule: 'minLength' }))).toEqual({
      title: 'Title is longer than this server allows. Shorten it and try again.',
      content: 'Content must be at least 10 characters.',
    })
  })

  test('maps status and unknown rules', () => {
    expect(serverFieldErrors(validation({ path: '/status', rule: 'type' }, { path: '/title', rule: 'type' }))).toEqual({
      status: 'Choose draft or published.',
      title: 'Title was not accepted by the server.',
    })
  })

  test('keeps the first issue per field and ignores other paths and malformed entries', () => {
    const error = validation({ path: '/title', rule: 'minLength' }, { path: '/title', rule: 'maxLength' }, { path: '', rule: 'minProperties' }, { path: 1 }, null)
    expect(serverFieldErrors(error)).toEqual({ title: 'Title must be at least 3 characters.' })
  })

  test('ignores everything but a 400 VALIDATION_ERROR', () => {
    expect(serverFieldErrors(new ApiError(403, 'FORBIDDEN', 'x', { fields: [{ path: '/title', rule: 'minLength' }] }))).toEqual({})
    expect(serverFieldErrors(new ApiError(400, 'VALIDATION_ERROR', 'Invalid request'))).toEqual({})
    expect(serverFieldErrors(new Error('network'))).toEqual({})
  })
})

describe('validatePostsSearch', () => {
  test.each([
    [{ page: 2 }, { page: 2 }],
    [{ page: '3' }, { page: 3 }],
    [{ page: MAX_PAGE }, { page: MAX_PAGE }],
  ])('keeps a page the API accepts: %p', (search, expected) => {
    expect(validatePostsSearch(search)).toEqual(expected)
  })

  test.each([[{}], [{ page: 1 }], [{ page: 0 }], [{ page: -1 }], [{ page: 1.5 }], [{ page: MAX_PAGE + 1 }], [{ page: 'abc' }], [{ page: '' }], [{ page: null }]])(
    'drops %p, so the list shows page 1',
    (search) => {
      expect(validatePostsSearch(search)).toEqual({})
      expect(pageOf(validatePostsSearch(search))).toBe(1)
    },
  )
})

describe('canChangePost', () => {
  const grants = (...granted: string[]) => (permission: string) => granted.includes(permission)
  const own = { authorId: 'usr_alice' }
  const other = { authorId: 'usr_bob' }

  test('the author with posts:write', () => {
    expect(canChangePost(own, 'usr_alice', grants('posts:write'))).toBe(true)
  })

  test("someone else's post needs posts:manage_all as well", () => {
    expect(canChangePost(other, 'usr_alice', grants('posts:write'))).toBe(false)
    expect(canChangePost(other, 'usr_alice', grants('posts:write', 'posts:manage_all'))).toBe(true)
  })

  test('nothing without posts:write, even the author or with manage_all', () => {
    expect(canChangePost(own, 'usr_alice', grants('posts:read'))).toBe(false)
    expect(canChangePost(other, 'usr_alice', grants('posts:manage_all'))).toBe(false)
  })

  test('nothing without a known user', () => {
    expect(canChangePost(own, undefined, grants('posts:write', 'posts:manage_all'))).toBe(false)
  })
})

describe('error mapping', () => {
  test('a missing post: 404, or a 400 because the id is not an id', () => {
    expect(isMissingPost(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))).toBe(true)
    expect(isMissingPost(new ApiError(400, 'VALIDATION_ERROR', 'Invalid request'))).toBe(true)
    expect(isMissingPost(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(false)
    expect(isMissingPost(new Error('network'))).toBe(false)
    expect(isMissingPost(null)).toBe(false)
  })

  test('isForbidden', () => {
    expect(isForbidden(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(true)
    expect(isForbidden(new ApiError(401, 'UNAUTHORIZED', 'x'))).toBe(false)
  })

  test('shows the API code with a message written here', () => {
    expect(postsErrorView(new ApiError(403, 'FORBIDDEN', 'raw'), 'update')).toEqual({
      code: 'FORBIDDEN',
      message: 'You can change only your own posts, unless your role allows managing all posts.',
    })
    expect(postsErrorView(new ApiError(401, 'UNAUTHORIZED', 'raw'), 'list').message).toBe('Your session has ended. Sign in again to continue.')
    expect(postsErrorView(new ApiError(404, 'POST_NOT_FOUND', 'raw'), 'delete').message).toBe('This post no longer exists. It may have been deleted.')
    expect(postsErrorView(new ApiError(400, 'VALIDATION_ERROR', 'raw'), 'create').message).toBe('The server did not accept the post. Check the fields below.')
    expect(postsErrorView(new ApiError(500, 'INTERNAL_ERROR', 'raw'), 'list')).toEqual({ code: 'INTERNAL_ERROR', message: 'The posts could not be loaded. Try again.' })
  })

  test('anything that is not an API answer is a network error', () => {
    expect(postsErrorView(new TypeError('fetch failed'), 'read').code).toBe(NETWORK_ERROR)
  })

  test('forbiddenView uses the API code', () => {
    expect(forbiddenView('delete')).toEqual({ code: 'FORBIDDEN', message: 'You can delete only your own posts, unless your role allows managing all posts.' })
  })
})

describe('formatTimestamp', () => {
  test('writes the ISO time in UTC, the same on the server and in the browser', () => {
    expect(formatTimestamp('2026-11-04T05:22:31.000Z')).toBe('2026-11-04 05:22 UTC')
  })

  test('leaves anything else as it is', () => {
    expect(formatTimestamp('not a date')).toBe('not a date')
  })
})

describe('postsKeys', () => {
  test('every list page sits under lists(), every detail under details()', () => {
    expect(postsKeys.list(2, 20)).toEqual(['posts', 'list', { page: 2, limit: 20 }])
    expect(postsKeys.list(2, 20).slice(0, 2)).toEqual([...postsKeys.lists()])
    expect(postsKeys.detail('id-1')).toEqual(['posts', 'detail', 'id-1'])
    expect(postsKeys.detail('id-1').slice(0, 2)).toEqual([...postsKeys.details()])
  })
})
