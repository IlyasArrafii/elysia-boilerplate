import { expect, test } from 'bun:test'
import { uniqueIp as setupUniqueIp } from '../utils/auth/setup'
import { authHeaders } from './auth'
import { uniqueIp } from './ip'

// The sign-in rate limit counts per IP in a store the whole test process shares. Two helpers that each kept
// their own counter handed out `10.0.0.1`, `10.0.0.2`, ... twice, so "the sixth attempt is 429" failed on
// the fifth whenever another file had signed in from the same address in the last minute (TASK-11).
test('every helper draws client IPs from one sequence, so no address is handed out twice', () => {
  const addresses = [
    authHeaders()['x-forwarded-for'],
    setupUniqueIp(),
    authHeaders()['x-forwarded-for'],
    uniqueIp(),
    setupUniqueIp(),
  ]

  expect(new Set(addresses).size).toBe(addresses.length)
})

test('addresses stay inside 10.0.0.0/8 and valid octets past the first 255', () => {
  const addresses = Array.from({ length: 600 }, () => uniqueIp())

  for (const address of addresses) {
    const octets = address.split('.').map(Number)
    expect(octets).toHaveLength(4)
    expect(octets[0]).toBe(10)
    expect(octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)).toBe(true)
  }
  expect(new Set(addresses).size).toBe(addresses.length)
})
