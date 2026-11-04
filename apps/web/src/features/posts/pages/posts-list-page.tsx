import { Button } from '@repo/ui'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { usePermissions, useSession } from '@/features/auth'
import { PostAuthor } from '../components/post-author'
import { PostForm } from '../components/post-form'
import { PostStatusLabel } from '../components/post-status'
import { ButtonLink, TextLink } from '../components/links'
import { ErrorAlert } from '../components/error-alert'
import { LoadError, PermissionsUnavailable, PostsMain, RowsSkeleton } from '../components/states'
import { useCreatePost } from '../hooks/use-post-mutations'
import { usePostsList } from '../hooks/use-posts'
import { readDeniedView } from '../lib/access'
import { formatTimestamp } from '../lib/format'
import { pageOf, validatePostsSearch } from '../lib/search'
import type { Post, PostList } from '../lib/types'
import { DEFAULT_STATUS, type PostValues } from '../lib/validation'

const NEW_POST_ID = 'new-post'
const EMPTY_POST: PostValues = { title: '', content: '', status: DEFAULT_STATUS }

// Moves the keyboard (and the viewport, on a phone where the form sits below the list) to the create form.
function focusNewPost() {
  document.getElementById(`${NEW_POST_ID}-title`)?.focus()
}

// /posts: one page of every post, newest first, beside the create form (DESIGN.md §6: data list + inline form).
// The route guard already required `posts:read`; writing needs `posts:write`.
export function PostsListPage() {
  const page = pageOf(validatePostsSearch(useSearch({ strict: false })))
  const list = usePostsList(page)
  const access = usePermissions()
  const userId = useSession().data?.user.id
  const create = useCreatePost()
  const navigate = useNavigate()
  // A refused read hides the cached rows and the form with them; the API would refuse the write the same way.
  const denied = readDeniedView(list.error, access, 'list')
  const canWrite = denied === null && access.can('posts:write')

  async function submit(values: PostValues) {
    const post = await create.mutateAsync(values)
    await navigate({ to: '/posts/$postId', params: { postId: post.id } })
  }

  return (
    <PostsMain>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-h1 text-primary">Posts</h1>
          <p className="mt-2 text-muted">Every post, newest first. You can edit and delete your own.</p>
        </div>
        {canWrite && (
          <Button onClick={focusNewPost} className="lg:hidden">
            Write a post
          </Button>
        )}
      </header>

      {access.status === 'unavailable' && (
        <div className="mt-6">
          <PermissionsUnavailable error={access.error} onRetry={access.retry} />
        </div>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-12 lg:gap-4">
        <section aria-labelledby="posts-heading" className={canWrite ? 'min-w-0 lg:col-span-8' : 'min-w-0 lg:col-span-12'}>
          <h2 id="posts-heading" className="sr-only">
            All posts
          </h2>
          {denied ? (
            <ErrorAlert error={denied} />
          ) : list.data ? (
            <PostsTable list={list.data} userId={userId} canWrite={canWrite} />
          ) : list.error ? (
            <LoadError error={list.error} action="list" onRetry={() => void list.refetch()} />
          ) : (
            <RowsSkeleton label="Loading posts" />
          )}
        </section>

        {canWrite && (
          <section aria-labelledby="new-post-heading" className="lg:col-span-4">
            <h2 id="new-post-heading" className="text-h2">
              New post
            </h2>
            <div className="mt-3">
              <PostForm
                idPrefix={NEW_POST_ID}
                label="New post"
                mode="create"
                initialValues={EMPTY_POST}
                submitLabel="Create post"
                pendingLabel="Creating…"
                pending={create.isPending}
                error={create.error}
                onSubmit={submit}
              />
            </div>
          </section>
        )}
      </div>
    </PostsMain>
  )
}

function PostsTable({ list, userId, canWrite }: Readonly<{ list: PostList; userId: string | undefined; canWrite: boolean }>) {
  const { items, meta } = list

  if (meta.total === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
        <p>No posts yet.</p>
        {canWrite && <Button onClick={focusNewPost}>Write the first post</Button>}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p className="border-y border-border py-3">
        There are no posts on page {meta.page}.{' '}
        <TextLink to="/posts" search={{}}>
          Go to the first page
        </TextLink>
      </p>
    )
  }

  return (
    <>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Posts, newest first</caption>
        <thead>
          <tr className="border-b border-border text-caption text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Title
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
              Author
            </th>
            <th scope="col" className="hidden py-2 font-medium sm:table-cell">
              Created
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((post) => (
            <PostRow key={post.id} post={post} userId={userId} />
          ))}
        </tbody>
      </table>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} />
    </>
  )
}

function PostRow({ post, userId }: Readonly<{ post: Post; userId: string | undefined }>) {
  return (
    <tr className="border-b border-border align-top">
      <td className="py-2 pr-3 break-words">
        <TextLink to="/posts/$postId" params={{ postId: post.id }}>
          {post.title}
        </TextLink>
      </td>
      <td className="py-2 pr-3">
        <PostStatusLabel status={post.status} />
      </td>
      <td className="hidden max-w-40 py-2 pr-3 sm:table-cell">
        <PostAuthor authorId={post.authorId} userId={userId} />
      </td>
      <td className="hidden py-2 font-mono text-mono whitespace-nowrap text-muted sm:table-cell">
        <time dateTime={post.createdAt}>{formatTimestamp(post.createdAt)}</time>
      </td>
    </tr>
  )
}

function Pagination({ page, totalPages, total }: Readonly<{ page: number; totalPages: number; total: number }>) {
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3">
      {page > 1 ? (
        <ButtonLink to="/posts" search={page - 1 > 1 ? { page: page - 1 } : {}}>
          Previous page
        </ButtonLink>
      ) : (
        <span />
      )}
      <p className="text-caption text-muted">
        Page {page} of {Math.max(totalPages, 1)} · {total} {total === 1 ? 'post' : 'posts'}
      </p>
      {page < totalPages ? (
        <ButtonLink to="/posts" search={{ page: page + 1 }}>
          Next page
        </ButtonLink>
      ) : (
        <span />
      )}
    </nav>
  )
}
