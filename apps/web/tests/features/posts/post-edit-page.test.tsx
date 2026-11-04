import {
  ADMIN_ACCESS,
  ALICE,
  apiFailed,
  forbidden,
  getPost,
  getSession,
  notFound,
  ok,
  OTHER_POST,
  OWN_POST,
  patchPost,
  permissionsGet,
  READ_ONLY_ACCESS,
  resetPostsMocks,
  USER_ACCESS,
  validationFailed,
  type PostData,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { postsKeys } from '@/features/posts/lib/keys'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

const editPath = (post: PostData) => `/posts/${post.id}/edit`

beforeEach(() => {
  resetPostsMocks()
  getSession.mockResolvedValue(ok(ALICE))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
  getPost.mockImplementation(async (id) => (id === OWN_POST.id ? ok(OWN_POST) : id === OTHER_POST.id ? ok(OTHER_POST) : notFound()))
})

async function openOwnForm() {
  const user = userEvent.setup()
  const app = await renderApp(editPath(OWN_POST))
  return { user, ...app, form: await screen.findByRole('form', { name: 'Edit post' }) }
}

describe('PostEditPage', () => {
  test('the form starts with the post as stored', async () => {
    const { form } = await openOwnForm()

    expect((within(form).getByLabelText('Title') as HTMLInputElement).value).toBe(OWN_POST.title)
    expect((within(form).getByLabelText('Content') as HTMLTextAreaElement).value).toBe(OWN_POST.content)
    expect((within(form).getByRole('radio', { name: 'Published' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(OWN_POST.id)).toBeDefined()
  })

  test('saving sends only what changed, once, and shows the saved post', async () => {
    const saved = { ...OWN_POST, title: 'Alice rewrites', updatedAt: '2026-11-04T10:00:00.000Z' }
    patchPost.mockImplementation(async () => {
      getPost.mockResolvedValue(ok(saved))
      return ok(saved)
    })
    const { user, form, router } = await openOwnForm()

    const title = within(form).getByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'Alice rewrites')
    await user.dblClick(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(currentHref(router)).toBe(`/posts/${OWN_POST.id}`))
    expect(patchPost).toHaveBeenCalledTimes(1)
    expect(patchPost).toHaveBeenCalledWith(OWN_POST.id, { title: 'Alice rewrites' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Alice rewrites' })).toBeDefined()
  })

  test('saving without a change sends nothing and says so', async () => {
    const { user, form } = await openOwnForm()

    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    expect(within(form).getByText('Nothing has changed yet. Edit a field, or cancel.')).toBeDefined()
    expect(patchPost).not.toHaveBeenCalled()
  })

  test('invalid input is caught before any request', async () => {
    const { user, form } = await openOwnForm()

    await user.clear(within(form).getByLabelText('Title'))
    await user.type(within(form).getByLabelText('Title'), 'ab')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    expect(within(form).getByText('Title must be at least 3 characters.')).toBeDefined()
    expect(patchPost).not.toHaveBeenCalled()
  })

  test("the server's 400 lands on the field it names", async () => {
    patchPost.mockResolvedValue(validationFailed({ path: '/title', rule: 'maxLength' }))
    const { user, form } = await openOwnForm()

    await user.type(within(form).getByLabelText('Title'), ' and more')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    expect(await within(form).findByText('Title is longer than this server allows. Shorten it and try again.')).toBeDefined()
    expect(within(form).getByLabelText('Title').getAttribute('aria-invalid')).toBe('true')
  })

  test('Cancel goes back to the post', async () => {
    const { form } = await openOwnForm()

    expect(within(form).getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe(`/posts/${OWN_POST.id}`)
  })

  test("another user's post without posts:manage_all shows forbidden instead of the form", async () => {
    await renderApp(editPath(OTHER_POST))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('FORBIDDEN')).toBeDefined()
    expect(within(alert).getByText('You can change only your own posts, unless your role allows managing all posts.')).toBeDefined()
    expect(screen.queryByRole('form', { name: 'Edit post' })).toBeNull()
  })

  test("posts:manage_all may edit another user's post", async () => {
    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))

    await renderApp(editPath(OTHER_POST))

    expect(await screen.findByRole('form', { name: 'Edit post' })).toBeDefined()
  })

  test('without posts:write the route sends the visitor to / with the forbidden notice', async () => {
    permissionsGet.mockResolvedValue(ok(READ_ONLY_ACCESS))

    const { router } = await renderApp(editPath(OWN_POST))

    expect(currentHref(router)).toBe('/?notice=forbidden')
  })

  test('a 403 on save (grants changed since they were read) refreshes them, and the form gives way to forbidden', async () => {
    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))
    patchPost.mockImplementation(async () => {
      permissionsGet.mockResolvedValue(ok(USER_ACCESS))
      return forbidden()
    })
    const user = userEvent.setup()
    await renderApp(editPath(OTHER_POST))
    const form = await screen.findByRole('form', { name: 'Edit post' })

    await user.type(within(form).getByLabelText('Title'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit post' })).toBeNull())
    expect(screen.getByText('You can change only your own posts, unless your role allows managing all posts.')).toBeDefined()
  })

  test('a post deleted elsewhere: saving turns the page into "not found"', async () => {
    patchPost.mockImplementation(async () => {
      getPost.mockResolvedValue(notFound())
      return notFound()
    })
    const { user, form } = await openOwnForm()

    await user.type(within(form).getByLabelText('Title'), '!')
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Post not found' })).toBeDefined()
  })

  test('a missing post has no form', async () => {
    await renderApp('/posts/0b5c1f8e-1a2b-4c3d-8e9f-0000000000ff/edit')

    expect(await screen.findByRole('heading', { level: 1, name: 'Post not found' })).toBeDefined()
    expect(screen.queryByRole('form', { name: 'Edit post' })).toBeNull()
  })

  test('a load error shows the code with "Try again"', async () => {
    getPost.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderApp(editPath(OWN_POST))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined()
  })
})

describe('while the form is open', () => {
  const CHANGED_ELSEWHERE = { ...OWN_POST, content: 'Bob fixed a typo in this post.', updatedAt: '2026-11-04T09:00:00.000Z' }

  test('a refetch bringing an edit made elsewhere does not mark that field changed: saving sends only the title', async () => {
    patchPost.mockImplementation(async (_id, body) => ok({ ...CHANGED_ELSEWHERE, ...body }))
    const { user, form, queryClient } = await openOwnForm()

    const title = within(form).getByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'Alice rewrites')
    getPost.mockResolvedValue(ok(CHANGED_ELSEWHERE))
    await queryClient.refetchQueries({ queryKey: postsKeys.detail(OWN_POST.id), exact: true })
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(patchPost).toHaveBeenCalledTimes(1))
    expect(patchPost).toHaveBeenCalledWith(OWN_POST.id, { title: 'Alice rewrites' })
  })

  test('an untouched form still sends nothing after such a refetch', async () => {
    const { user, form, queryClient } = await openOwnForm()

    getPost.mockResolvedValue(ok(CHANGED_ELSEWHERE))
    await queryClient.refetchQueries({ queryKey: postsKeys.detail(OWN_POST.id), exact: true })
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))

    expect(within(form).getByText('Nothing has changed yet. Edit a field, or cancel.')).toBeDefined()
    expect(patchPost).not.toHaveBeenCalled()
  })

  test('a 403 on a refetch takes the form away, even with the post still cached', async () => {
    const { queryClient } = await openOwnForm()

    getPost.mockResolvedValue(forbidden())
    await queryClient.refetchQueries({ queryKey: postsKeys.detail(OWN_POST.id), exact: true })

    expect(await screen.findByText('Your role does not allow reading posts.')).toBeDefined()
    expect(screen.queryByRole('form', { name: 'Edit post' })).toBeNull()
    expect(screen.queryByText(OWN_POST.id)).toBeNull()
  })
})
