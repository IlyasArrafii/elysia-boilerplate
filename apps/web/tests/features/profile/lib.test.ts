import { describe, expect, test } from 'bun:test'
import { nameError, previewSource, toProfileValues, toUserUpdate } from '@/features/profile/lib/validation'

describe('nameError', () => {
  test.each(['', '   ', '\t'])('requires a name: %p', (name) => {
    expect(nameError(name)).toBe('Enter your name.')
  })

  test('sets no length or format limit the API does not have', () => {
    expect(nameError('A')).toBeUndefined()
    expect(nameError('a'.repeat(1000))).toBeUndefined()
  })
})

describe('previewSource', () => {
  test.each([
    'https://img.example.test/a.png',
    'http://img.example.test/a.png',
    'HTTPS://img.example.test/a.png',
    '/avatar.png',
    'avatar.png',
    '//img.example.test/a.png',
    'data:image/png;base64,AAAA',
  ])('shows %p', (image) => {
    expect(previewSource(image)).toBe(image)
  })

  test.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<p>x</p>', 'file:///etc/passwd', 'ftp://img.example.test/a.png'])(
    'does not show %p',
    (image) => {
      expect(previewSource(image)).toBeUndefined()
    },
  )

  test('no image shows nothing', () => {
    expect(previewSource(null)).toBeUndefined()
    expect(previewSource('')).toBeUndefined()
  })
})

describe('toUserUpdate', () => {
  test('trims both fields and turns an empty image into null (no image)', () => {
    expect(toUserUpdate({ name: '  Alice ', image: '  ' })).toEqual({ name: 'Alice', image: null })
    expect(toUserUpdate({ name: 'Alice', image: ' https://img.example.test/a.png ' })).toEqual({
      name: 'Alice',
      image: 'https://img.example.test/a.png',
    })
  })

  test('sends only name and image: never email or anything else', () => {
    expect(Object.keys(toUserUpdate({ name: 'Alice', image: '' })).sort()).toEqual(['image', 'name'])
  })
})

describe('toProfileValues', () => {
  test('a missing image is an empty field', () => {
    expect(toProfileValues({ name: 'Alice', image: null })).toEqual({ name: 'Alice', image: '' })
  })
})
