import { describe, expect, test } from 'bun:test'
import { effectiveEnv, fillEmptyValues, parseEnv } from './env-file'

const fixed = (value: string) => () => value

describe('parseEnv', () => {
  test('reads values the way Bun loads them', () => {
    const values = parseEnv(
      [
        '# a comment',
        'PLAIN=value',
        'export EXPORTED=yes',
        '  SPACED = padded  ',
        'INLINE=kept # dropped',
        'HASH=x#y',
        'DOUBLE="has # inside"',
        "SINGLE='single'",
        'EMPTY=',
        'DUPLICATE=first',
        'DUPLICATE=second',
        'not an assignment',
      ].join('\n'),
    )

    expect(Object.fromEntries(values)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'yes',
      SPACED: 'padded',
      INLINE: 'kept',
      HASH: 'x',
      DOUBLE: 'has # inside',
      SINGLE: 'single',
      EMPTY: '',
      DUPLICATE: 'second',
    })
  })

  test('ignores the carriage return of CRLF files', () => {
    expect(parseEnv('A=1\r\nB=\r\n').get('A')).toBe('1')
    expect(parseEnv('A=1\r\nB=\r\n').get('B')).toBe('')
  })
})

describe('fillEmptyValues', () => {
  test('fills empty values and keeps every other line as written', () => {
    const text = '# Auth\nBETTER_AUTH_SECRET=\n\n# Seed\nSEED_SUPER_ADMIN_EMAIL=admin@example.test\nSEED_SUPER_ADMIN_PASSWORD=\n'

    const result = fillEmptyValues(text, { BETTER_AUTH_SECRET: fixed('s3cret'), SEED_SUPER_ADMIN_PASSWORD: fixed('pw') })

    expect(result.text).toBe(
      '# Auth\nBETTER_AUTH_SECRET=s3cret\n\n# Seed\nSEED_SUPER_ADMIN_EMAIL=admin@example.test\nSEED_SUPER_ADMIN_PASSWORD=pw\n',
    )
    expect(result.filled).toEqual(['BETTER_AUTH_SECRET', 'SEED_SUPER_ADMIN_PASSWORD'])
  })

  test('never touches a value that is already set', () => {
    const text = 'BETTER_AUTH_SECRET=mine\nSEED_SUPER_ADMIN_PASSWORD="quoted"\n'
    let generated = 0
    const result = fillEmptyValues(text, {
      BETTER_AUTH_SECRET: () => `${++generated}`,
      SEED_SUPER_ADMIN_PASSWORD: () => `${++generated}`,
    })

    expect(result).toEqual({ text, filled: [] })
    expect(generated).toBe(0)
  })

  test('treats quoted-empty and comment-only values as empty, keeping the comment', () => {
    const result = fillEmptyValues('A=""\nB= # pick one\n', { A: fixed('1'), B: fixed('2') })
    expect(result.text).toBe('A=1\nB=2 # pick one\n')
  })

  test('keeps CRLF line endings, including on an appended key', () => {
    const result = fillEmptyValues('A=\r\nB=keep\r\n', { A: fixed('1'), C: fixed('3') })
    expect(result.text).toBe('A=1\r\nB=keep\r\nC=3\r\n')
  })

  test('appends a missing key, adding the final newline the file lacked', () => {
    const result = fillEmptyValues('A=1', { B: fixed('2') })
    expect(result).toEqual({ text: 'A=1\nB=2\n', filled: ['B'] })
  })

  test('fills the last of duplicate assignments, the one Bun uses', () => {
    expect(fillEmptyValues('A=old\nA=\n', { A: fixed('new') }).text).toBe('A=old\nA=new\n')
    expect(fillEmptyValues('A=\nA=set\n', { A: fixed('new') }).text).toBe('A=\nA=set\n')
  })

  test('keeps an export prefix', () => {
    expect(fillEmptyValues('export A=\n', { A: fixed('1') }).text).toBe('export A=1\n')
  })

  test('is idempotent: a second pass changes nothing', () => {
    const generators = { A: fixed('1'), B: fixed('2') }
    const first = fillEmptyValues('A=\n', generators)
    expect(fillEmptyValues(first.text, generators)).toEqual({ text: first.text, filled: [] })
  })
})

describe('effectiveEnv', () => {
  const file = new Map([
    ['A', 'file'],
    ['B', 'file'],
    ['C', 'same'],
  ])

  test('lets the shell win over the file, even with an empty value', () => {
    const { values } = effectiveEnv(file, { A: 'shell', B: '' }, ['A', 'B', 'C', 'D'])
    expect(values).toEqual({ A: 'shell', B: '', C: 'same', D: '' })
  })

  test('lists the keys whose file value the shell hides', () => {
    const { overridden } = effectiveEnv(file, { A: 'shell', C: 'same', D: 'only-shell' }, ['A', 'C', 'D'])
    expect(overridden).toEqual(['A'])
  })
})
