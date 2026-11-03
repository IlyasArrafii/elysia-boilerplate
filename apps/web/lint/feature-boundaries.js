// @ts-check
// Oxlint JS plugin enforcing apps/web R4: code outside a feature imports it only through
// `@/features/<feature>` (its index.ts). Plain JavaScript so it runs on every Node version oxlint supports.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))
const INDEX_FILE = /^index(\.[cm]?[jt]sx?)?$/

/**
 * `target` as a `/`-separated path relative to `root`, or null when it lies outside `root`.
 * @param {string} root
 * @param {string} target
 * @returns {string | null}
 */
function relativeInside(root, target) {
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * The feature whose internals `specifier` reaches into from `importer`, or null when the import is allowed.
 * Only files under `srcRoot` are checked: tests import feature internals on purpose (apps/web R33).
 * @param {string} importer absolute path of the importing file
 * @param {string} specifier the import source as written
 * @param {string} [srcRoot] absolute path of apps/web/src
 * @returns {string | null}
 */
export function deepFeatureImport(importer, specifier, srcRoot = SRC_ROOT) {
  const importerPath = relativeInside(srcRoot, importer)
  if (importerPath === null) return null

  // Resolve both spellings to a normalized path so `.`/`..` segments cannot hide the feature folder.
  let target
  if (specifier.startsWith('@/')) target = path.resolve(srcRoot, specifier.slice(2))
  else if (specifier.startsWith('.')) target = path.resolve(path.dirname(importer), specifier)
  else return null
  const targetPath = relativeInside(srcRoot, target)
  if (targetPath === null) return null

  const [top, feature, ...rest] = targetPath.split('/').filter(Boolean)
  if (top !== 'features' || !feature || rest.length === 0) return null
  if (rest.length === 1 && INDEX_FILE.test(rest[0] ?? '')) return null

  const [importerTop, importerFeature] = importerPath.split('/')
  if (importerTop === 'features' && importerFeature === feature) return null
  return feature
}

/**
 * @typedef {{ type: string, value?: unknown }} SourceNode
 * @typedef {{ source?: SourceNode | null }} NodeWithSource
 * @typedef {{ filename: string, report: (descriptor: { node: SourceNode, messageId: string, data: Record<string, string> }) => void }} RuleContext
 */

const noDeepImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Import a feature only through its index.ts (`@/features/<feature>`)' },
    messages: {
      deep: 'Import "{{specifier}}" reaches into feature "{{feature}}". Import from "@/features/{{feature}}" instead (apps/web R4).',
    },
    schema: [],
  },
  /** @param {RuleContext} context */
  create(context) {
    /** @param {NodeWithSource} node */
    const check = (node) => {
      const source = node.source
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return
      const feature = deepFeatureImport(context.filename, source.value)
      if (feature) context.report({ node: source, messageId: 'deep', data: { specifier: source.value, feature } })
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    }
  },
}

export default {
  meta: { name: 'feature-boundaries' },
  rules: { 'no-deep-import': noDeepImport },
}
