// Console output for setup and doctor. Every line goes through redact(), so a secret that slipped into
// a driver error message is masked before it reaches the terminal.
import { redact, type Check, type CheckStatus } from './checks'

const SYMBOLS: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', fail: '✖' }
const COLORS: Record<CheckStatus, number> = { ok: 32, warn: 33, fail: 31 }

const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined

export function paint(status: CheckStatus, text: string): string {
  return color ? `\x1b[${COLORS[status]}m${text}\x1b[0m` : text
}

export function bold(text: string): string {
  return color ? `\x1b[1m${text}\x1b[0m` : text
}

export interface Printer {
  line(text?: string): void
  check(check: Check): void
}

export function createPrinter(secrets: readonly string[]): Printer {
  const line = (text = '') => console.log(redact(text, secrets))
  return {
    line,
    check(check) {
      line(`  ${paint(check.status, SYMBOLS[check.status])} ${check.title}`)
      if (check.fix !== undefined && check.status !== 'ok') line(`      → ${check.fix}`)
    },
  }
}
