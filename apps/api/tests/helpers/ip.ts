import { env } from '../../src/env'

// The one source of client IPs for tests that sign in. The sign-in rate limit (5 a minute per IP) counts in a
// store that the whole `bun test` process shares, so two generators handing out the same address would make one
// test's attempts count against another's, depending on which files run first. `helpers/auth.ts` and
// `utils/auth/setup.ts` both use this one.
let counter = 0

export function uniqueIp(): string {
  counter++
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`
}

// The header that carries a client IP, as the API reads it (CLIENT_IP_HEADER). Every test that picks a
// client IP sends it through here, so the header name lives in `env.ts` alone. API E2E reads the same
// variable, which the running API under test is started with.
export function clientIp(ip: string = uniqueIp()): Record<string, string> {
  return { [env.CLIENT_IP_HEADER]: ip }
}
