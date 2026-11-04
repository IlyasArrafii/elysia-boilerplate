// `2026-11-04T05:22:31.000Z` → `2026-11-04 05:22 UTC`. Written out from the ISO string rather than with the
// visitor's locale and time zone, so the server-rendered HTML and the hydrated page always agree.
export function formatTimestamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  return match ? `${match[1]} ${match[2]} UTC` : iso
}
