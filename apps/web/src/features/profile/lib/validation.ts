import type { UserUpdate } from '@/features/auth'

// Client checks for the profile form (apps/web R21, R22). POST /api/auth/update-user (Better Auth 1.7.15) accepts any
// value for `name` and `image` and sets no length or format limits, so none are added here: the only check stops an
// empty name. Which image addresses are shown as a preview is decided when rendering (`previewSource`), not here, so
// a stored value the app cannot show never blocks saving the name.
export interface ProfileValues {
  name: string
  // Empty means no image.
  image: string
}

export function nameError(name: string): string | undefined {
  return name.trim() === '' ? 'Enter your name.' : undefined
}

// The image addresses the page shows in an <img>: web addresses, absolute or on this site, and inline images. Anything
// else (`javascript:`, `file:`, an unknown scheme) is stored as given but not shown.
const PREVIEW_PROTOCOLS = new Set(['https:', 'http:'])

export function previewSource(image: string | null): string | undefined {
  if (!image) return undefined
  if (/^data:image\//i.test(image)) return image
  // Any http(s) base works: it only resolves a relative address so its scheme can be read.
  const url = URL.parse(image, 'https://origin.invalid/')
  return url && PREVIEW_PROTOCOLS.has(url.protocol) ? image : undefined
}

// What is sent: trimmed, and an empty image removes the current one.
export function toUserUpdate(values: ProfileValues): UserUpdate {
  return { name: values.name.trim(), image: values.image.trim() || null }
}

export function toProfileValues(user: { name: string; image: string | null }): ProfileValues {
  return { name: user.name, image: user.image ?? '' }
}
