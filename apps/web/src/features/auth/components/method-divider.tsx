// Separates the two ways to sign in (email form, Google) with hairlines, per DESIGN.md §3.
export function MethodDivider() {
  return (
    <div className="my-6 flex items-center gap-3 text-caption text-muted" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-border" />
      <span aria-hidden="true">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
