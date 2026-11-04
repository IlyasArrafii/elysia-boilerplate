import { Button } from '@repo/ui'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePermissions, useSession, type PermissionsState } from '@/features/auth'
import { DeletePostDialog } from '../components/delete-post-dialog'
import { ErrorAlert } from '../components/error-alert'
import { ButtonLink } from '../components/links'
import { PostAuthor } from '../components/post-author'
import { PostStatusLabel } from '../components/post-status'
import { BackToPosts, LoadError, MissingPost, PermissionsUnavailable, PostsMain, RowsSkeleton } from '../components/states'
import { useDeletePost } from '../hooks/use-post-mutations'
import { usePost } from '../hooks/use-posts'
import { canChangePost, readDeniedView } from '../lib/access'
import { isMissingPost } from '../lib/errors'
import { formatTimestamp } from '../lib/format'
import type { Post } from '../lib/types'

// /posts/:postId: one post. Edit and delete are offered to its author, or to a role with `posts:manage_all`.
export function PostDetailPage() {
  const { postId = '' } = useParams({ strict: false })
  const post = usePost(postId)
  const access = usePermissions()

  // A refetch that finds the post gone (deleted here or elsewhere), or refuses it, wins over the copy still cached.
  if (isMissingPost(post.error)) return <MissingPost error={post.error} />
  const denied = readDeniedView(post.error, access, 'read')
  let body
  if (denied) body = <ErrorAlert error={denied} />
  else if (post.data) return <PostView post={post.data} access={access} />
  else if (post.error) body = <LoadError error={post.error} action="read" onRetry={() => void post.refetch()} />
  else body = <RowsSkeleton label="Loading the post" rows={4} />
  return (
    <PostsMain>
      <BackToPosts />
      <div className="mt-6">{body}</div>
    </PostsMain>
  )
}

function PostView({ post, access }: Readonly<{ post: Post; access: PermissionsState }>) {
  const userId = useSession().data?.user.id
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const remove = useDeletePost(post.id, { onDeleted: () => navigate({ to: '/posts' }) })
  const canChange = canChangePost(post, userId, access.can)
  // Set synchronously, unlike `isPending`, so a double click on the confirm button sends one request (R23).
  const deleting = useRef(false)

  // Grants revoked or no longer known while the dialog is open: it closes, like the actions behind it (fail closed).
  // Its trigger is gone too, so focus moves to the heading first instead of falling to the document.
  useEffect(() => {
    if (!confirming || canChange) return
    heading.current?.focus()
    setConfirming(false)
  }, [confirming, canChange])

  function confirmDelete() {
    // Until the effect above closes the dialog, a confirm that access no longer allows is ignored.
    if (deleting.current || !canChange) return
    deleting.current = true
    remove.mutate(undefined, { onSettled: () => (deleting.current = false) })
  }

  function closeDialog() {
    setConfirming(false)
    remove.reset()
    deleteTrigger.current?.focus()
  }

  return (
    <PostsMain>
      <BackToPosts />
      <article aria-labelledby="post-heading" className="mt-4">
        <header className="border-b border-border pb-4">
          <h1 ref={heading} id="post-heading" tabIndex={-1} className="text-h1 break-words text-primary">
            {post.title}
          </h1>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            <Meta label="Status">
              <PostStatusLabel status={post.status} />
            </Meta>
            <Meta label="Author">
              <PostAuthor authorId={post.authorId} userId={userId} />
            </Meta>
            <Meta label="Created">
              <time dateTime={post.createdAt} className="font-mono text-mono">
                {formatTimestamp(post.createdAt)}
              </time>
            </Meta>
            <Meta label="Updated">
              <time dateTime={post.updatedAt} className="font-mono text-mono">
                {formatTimestamp(post.updatedAt)}
              </time>
            </Meta>
            <Meta label="Slug">
              <span className="font-mono text-mono break-all">{post.slug}</span>
            </Meta>
          </dl>
        </header>
        <div className="mt-6 max-w-prose break-words whitespace-pre-wrap">{post.content}</div>
      </article>

      <div className="mt-8 border-t border-border pt-4">
        {access.status === 'unavailable' && <PermissionsUnavailable error={access.error} onRetry={access.retry} />}
        {canChange && (
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/posts/$postId/edit" params={{ postId: post.id }}>
              Edit post
            </ButtonLink>
            <Button ref={deleteTrigger} variant="ghost" onClick={() => setConfirming(true)}>
              Delete post
            </Button>
          </div>
        )}
        {!canChange && access.status === 'ready' && access.can('posts:write') && (
          <p className="text-caption text-muted">Only the author, or a role allowed to manage all posts, can edit or delete this post.</p>
        )}
      </div>

      {confirming && (
        <DeletePostDialog post={post} pending={remove.isPending} error={remove.error} onConfirm={confirmDelete} onCancel={closeDialog} />
      )}
    </PostsMain>
  )
}

function Meta({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}
