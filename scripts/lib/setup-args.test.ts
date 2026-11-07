import { describe, expect, test } from 'bun:test'
import { parseSetupArgs } from './setup-args'

describe('parseSetupArgs', () => {
  test('runs everything when no option is given', () => {
    expect(parseSetupArgs([])).toEqual({ kind: 'run', skipInfra: false })
  })

  test('--skip-infra skips the services, also when repeated', () => {
    expect(parseSetupArgs(['--skip-infra'])).toEqual({ kind: 'run', skipInfra: true })
    expect(parseSetupArgs(['--skip-infra', '--skip-infra'])).toEqual({ kind: 'run', skipInfra: true })
  })

  test('--help and -h ask for the usage line', () => {
    expect(parseSetupArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseSetupArgs(['-h'])).toEqual({ kind: 'help' })
    expect(parseSetupArgs(['--skip-infra', '--help'])).toEqual({ kind: 'help' })
  })

  test('an unknown option is a usage error that names it', () => {
    expect(parseSetupArgs(['--bogus'])).toEqual({ kind: 'usage', message: 'Unknown option --bogus' })
    expect(parseSetupArgs(['skip-infra'])).toEqual({ kind: 'usage', message: 'Unknown option skip-infra' })
    expect(parseSetupArgs(['--skip-infra=true'])).toEqual({ kind: 'usage', message: 'Unknown option --skip-infra=true' })
  })

  test('the first decisive option wins', () => {
    expect(parseSetupArgs(['--bogus', '--help'])).toEqual({ kind: 'usage', message: 'Unknown option --bogus' })
    expect(parseSetupArgs(['--help', '--bogus'])).toEqual({ kind: 'help' })
  })
})
