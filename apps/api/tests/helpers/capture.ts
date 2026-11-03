import { createLogger, type Logger } from '../../src/utils/logger'

export interface CapturedLogger {
  logger: Logger
  // Everything written so far, exactly as it would reach stdout.
  output(): string
  lines(): Record<string, unknown>[]
  clear(): void
}

// `JSON.parse` keeps the last of a repeated key, so a duplicate can only be found in the text.
export function topLevelKeys(line: string): string[] {
  const keys: string[] = []
  let depth = 0

  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      let end = index + 1
      while (line[end] !== '"') end += line[end] === '\\' ? 2 : 1
      if (depth === 1 && line[end + 1] === ':') keys.push(line.slice(index + 1, end))
      index = end
    } else if (char === '{' || char === '[') {
      depth++
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
  return keys
}

export function expectNoDuplicateKeys(output: string): void {
  for (const line of output.split('\n').filter((candidate) => candidate !== '')) {
    const keys = topLevelKeys(line)
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
    if (duplicates.length > 0) throw new Error(`Duplicate keys ${duplicates.join(', ')} in: ${line}`)
  }
}

// A pino logger that writes to memory instead of stdout, for asserting on what would be printed.
export function captureLogger(): CapturedLogger {
  const chunks: string[] = []
  const logger = createLogger({
    level: 'trace',
    nodeEnv: 'test',
    stream: { write: (chunk) => void chunks.push(chunk) },
  })

  return {
    logger,
    output: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): Record<string, unknown> => JSON.parse(line)),
    clear: () => {
      chunks.length = 0
    },
  }
}
