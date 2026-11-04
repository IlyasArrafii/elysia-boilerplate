import { useNavigate, useParams } from '@tanstack/react-router'
import { usePermissions, useSession } from '@/features/auth'
import { ErrorAlert } from '../components/error-alert'
import { ButtonLink, TextLink } from '../components/links'
import { PostForm } from '../components/post-form'
import { FormSkeleton, LoadError, MissingPost, PermissionsUnavailable, PostsMain } from '../components/states'
import { useUpdatePost } from '../hooks/use-post-mutations'
import { usePost } from '../hooks/use-posts'
import { canChangePost, readDeniedView } from '../lib/access'
import { forbiddenView, isMissingPost } from '../lib/errors'
import type { Post } from '../lib/types'
import type { PostValues } from '../lib/validation'

// /posts/:postId/edit. The route guard required `posts:write`; the ownership rule needs the post, so it is checked
// here. UX only: the API applies the same rule to the PATCH.
export function PostEditPage() {
  const { postId = '' } = useParams({ strict: false })
  const post = usePost(postId)
  const access = usePermissions()
  const userId = useSession().data?.user.id

  if (isMissingPost(post.error)) return <MissingPost error={post.error} />
  // A refused refetch takes the form away too, even with the post still cached.
  const denied = readDeniedView(post.error, access, 'read')
  const shown = denied ? undefined : post.data

  let body
  if (denied) {
    body = <ErrorAlert error={denied} />
  } else if (!post.data) {
    body = post.error ? <LoadError error={post.error} action="read" onRetry={() => void post.refetch()} /> : <FormSkeleton label="Loading the post" />
  } else if (access.status === 'unavailable') {
    body = <PermissionsUnavailable error={access.error} onRetry={access.retry} />
  } else if (access.status !== 'ready') {
    body = <FormSkeleton label="Loading the post" />
  } else if (!canChangePost(post.data, userId, access.can)) {
    body = <ErrorAlert error={forbiddenView('update')} />
  } else {
    // Keyed by post: a background refetch never resets what is being typed, another post starts afresh.
    body = <EditForm key={post.data.id} post={post.data} />
  }

  return (
    <PostsMain>
      {shown ? (
        <TextLink to="/posts/$postId" params={{ postId: shown.id }}>
          Back to the post
        </TextLink>
      ) : (
        <TextLink to="/posts">All posts</TextLink>
      )}
      <h1 className="mt-4 text-h1 text-primary">Edit post</h1>
      {shown && <p className="mt-2 font-mono text-mono break-all text-muted">{shown.id}</p>}
      <div className="mt-6 max-w-2xl">{body}</div>
    </PostsMain>
  )
}

function EditForm({ post }: Readonly<{ post: Post }>) {
  const update = useUpdatePost(post.id)
  const navigate = useNavigate()
  const initialValues: PostValues = { title: post.title, content: post.content, status: post.status }

  async function submit(_values: PostValues, changes: Partial<PostValues>) {
    await update.mutateAsync(changes)
    await navigate({ to: '/posts/$postId', params: { postId: post.id } })
  }

  return (
    <PostForm
      idPrefix="edit-post"
      label="Edit post"
      mode="update"
      initialValues={initialValues}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      pending={update.isPending}
      error={update.error}
      onSubmit={submit}
    >
      <ButtonLink to="/posts/$postId" params={{ postId: post.id }}>
        Cancel
      </ButtonLink>
    </PostForm>
  )
}
