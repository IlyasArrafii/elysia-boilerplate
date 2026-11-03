// `userId` from a request body, read before Better Auth validates it (`hooks.before` runs first).
// The admin plugin parses it with `z.coerce.string()`, so `["id"]`, `[["id"]]` and `123` all reach
// the endpoint as strings that a guard comparing raw values would not recognise. Only a string is
// accepted; anything else is `undefined`, and the guards refuse it (hooks.ts).
export function readUserId(body: unknown): string | undefined {
  const value: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'userId') : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}
