import {
  ALICE,
  apiFailed,
  createPost,
  deletePost,
  forbidden,
  getPost,
  getSession,
  listOf,
  listPosts,
  notFound,
  ok,
  OWN_POST,
  patchPost,
  permissionsGet,
  resetPostsMocks,
  USER_ACCESS,
} from './api-mock'
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { postsKeys } from '@/features/posts/lib/keys'
import { ApiError } from '@/lib/api-error'

// Loaded after `./api-mock` has replaced the API clients.
const { testQueryClient } = await import('./app')
const { postQueryOptions, postsListQueryOptions } = await import('@/features/posts')
const { useCreatePost, useDeletePost, useUpdatePost } = await import('@/features/posts/hooks/use-post-mutations')
const { permissionsQueryOptions, sessionQueryOptions } = await import('@/features/auth')

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

// The keys a call to `invalidateQueries` named, in order.
function invalidatedKeys(spy: ReturnType<typeof spyOn<QueryClient, 'invalidateQueries'>>) {
  return spy.mock.calls.map(([filters]) => filters?.queryKey)
}

beforeEach(async () => {
  resetPostsMocks()
  getSession.mockResolvedValue(ok(ALICE))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
  queryClient = testQueryClient()
  // The mutation hooks read the signed-in user from the session query.
  await queryClient.fetchQuery(sessionQueryOptions)
})

describe('queries', () => {
  test('a list page asks for the page with the API default limit, under its own key', async () => {
    listPosts.mockResolvedValue(ok(listOf([OWN_POST])))

    const options = postsListQueryOptions(3)
    const data = await queryClient.fetchQuery(options)

    expect([...options.queryKey]).toEqual([...postsKeys.list(3, 20)])
    expect(listPosts).toHaveBeenCalledWith({ query: { page: 3, limit: 20 } })
    expect(data.items).toEqual([OWN_POST])
  })

  test('a detail is keyed by id', async () => {
    getPost.mockResolvedValue(ok(OWN_POST))

    const options = postQueryOptions(OWN_POST.id)
    expect(await queryClient.fetchQuery(options)).toEqual(OWN_POST)
    expect([...options.queryKey]).toEqual([...postsKeys.detail(OWN_POST.id)])
    expect(getPost).toHaveBeenCalledWith(OWN_POST.id)
  })

  test("Eden's { data, error } becomes a thrown ApiError with status and code", async () => {
    getPost.mockResolvedValue(notFound())

    const error = await queryClient.fetchQuery(postQueryOptions('missing')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: 'POST_NOT_FOUND' })
  })
})

describe('useCreatePost', () => {
  test('caches the new post as its detail and invalidates every list page', async () => {
    const created = { ...OWN_POST, id: 'new-id' }
    createPost.mockResolvedValue(ok(created))
    const spy = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreatePost(), { wrapper })

    act(() => result.current.mutate({ title: 'Alice writes', content: 'The first post by Alice.' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(createPost).toHaveBeenCalledWith({ title: 'Alice writes', content: 'The first post by Alice.' })
    expect(queryClient.getQueryData(postsKeys.detail('new-id'))).toEqual(created)
    expect(invalidatedKeys(spy)).toEqual([postsKeys.lists()])
  })

  test('a 403 re-asks for the permissions, which were stale', async () => {
    createPost.mockResolvedValue(forbidden())
    const spy = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreatePost(), { wrapper })

    act(() => result.current.mutate({ title: 'abc', content: '0123456789' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidatedKeys(spy)).toEqual([permissionsQueryOptions(ALICE.user.id).queryKey])
  })

  test('a 401 re-reads the session, so the session watcher can send the visitor to /login', async () => {
    createPost.mockResolvedValue(apiFailed(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' }))
    const spy = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreatePost(), { wrapper })

    act(() => result.current.mutate({ title: 'abc', content: '0123456789' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidatedKeys(spy)).toEqual([sessionQueryOptions.queryKey])
  })
})

describe('useUpdatePost', () => {
  test('sends only the changes, replaces the cached detail and invalidates the lists', async () => {
    const updated = { ...OWN_POST, title: 'Renamed' }
    patchPost.mockResolvedValue(ok(updated))
    queryClient.setQueryData(postsKeys.detail(OWN_POST.id), OWN_POST)
    const spy = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdatePost(OWN_POST.id), { wrapper })

    act(() => result.current.mutate({ title: 'Renamed' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(patchPost).toHaveBeenCalledWith(OWN_POST.id, { title: 'Renamed' })
    expect(queryClient.getQueryData(postsKeys.detail(OWN_POST.id))).toEqual(updated)
    expect(invalidatedKeys(spy)).toEqual([postsKeys.lists()])
  })

  test('a GET still in flight when the PATCH succeeds cannot put the old post back', async () => {
    const updated = { ...OWN_POST, title: 'Renamed' }
    let release!: (value: Awaited<ReturnType<typeof getPost>>) => void
    getPost.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const staleRead = queryClient.fetchQuery(postQueryOptions(OWN_POST.id)).catch(() => undefined)
    patchPost.mockResolvedValue(ok(updated))
    const { result } = renderHook(() => useUpdatePost(OWN_POST.id), { wrapper })

    act(() => result.current.mutate({ title: 'Renamed' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    release(ok(OWN_POST))
    await staleRead

    expect(queryClient.getQueryData(postsKeys.detail(OWN_POST.id))).toEqual(updated)
  })

  test('a 404 (deleted elsewhere) invalidates that detail and the lists', async () => {
    patchPost.mockResolvedValue(notFound())
    const spy = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdatePost(OWN_POST.id), { wrapper })

    act(() => result.current.mutate({ title: 'Renamed' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidatedKeys(spy)).toEqual([postsKeys.detail(OWN_POST.id), postsKeys.lists()])
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 404, code: 'POST_NOT_FOUND' }))
  })
})

describe('useDeletePost', () => {
  test('invalidates the lists, leaves the page, then drops the cached detail', async () => {
    deletePost.mockResolvedValue(ok(undefined))
    queryClient.setQueryData(postsKeys.detail(OWN_POST.id), OWN_POST)
    const spy = spyOn(queryClient, 'invalidateQueries')
    const order: string[] = []
    const onDeleted = async () => {
      order.push(queryClient.getQueryData(postsKeys.detail(OWN_POST.id)) ? 'left while cached' : 'left after drop')
    }
    const { result } = renderHook(() => useDeletePost(OWN_POST.id, { onDeleted }), { wrapper })

    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(deletePost).toHaveBeenCalledWith(OWN_POST.id)
    expect(order).toEqual(['left while cached'])
    expect(queryClient.getQueryData(postsKeys.detail(OWN_POST.id))).toBeUndefined()
    expect(invalidatedKeys(spy)).toEqual([postsKeys.lists()])
  })

  test('a failure keeps the detail and does not leave the page', async () => {
    deletePost.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))
    queryClient.setQueryData(postsKeys.detail(OWN_POST.id), OWN_POST)
    let left = false
    const { result } = renderHook(() => useDeletePost(OWN_POST.id, { onDeleted: async () => (left = true) }), { wrapper })

    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(left).toBe(false)
    expect(queryClient.getQueryData(postsKeys.detail(OWN_POST.id))).toEqual(OWN_POST)
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' }))
  })
})
