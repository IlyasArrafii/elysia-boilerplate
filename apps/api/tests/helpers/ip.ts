// The one source of client IPs for tests that sign in. The sign-in rate limit (5 a minute per IP) counts in a
// store that the whole `bun test` process shares, so two generators handing out the same address would make one
// test's attempts count against another's, depending on which files run first. `helpers/auth.ts` and
// `utils/auth/setup.ts` both use this one.
let counter = 0

export function uniqueIp(): string {
  counter++
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`
}
