// The author as the API reports it: an id. The signed-in user's own posts say "You".
export function PostAuthor({ authorId, userId }: Readonly<{ authorId: string; userId: string | undefined }>) {
  if (authorId === userId) return <span>You</span>
  return (
    <span className="block truncate font-mono text-mono" title={authorId}>
      {authorId}
    </span>
  )
}
