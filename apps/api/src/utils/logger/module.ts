import { Elysia, type AnyElysia } from 'elysia'
import { getRequestContext } from './context'

// Marks the hook so `mountModule` can tell which module name a controller declared.
const MODULE_NAME = Symbol('moduleScope')

// First `.use()` of every controller (apps/api R5). The hook is `scoped`, so it applies only to
// that controller's routes, and it runs before validation, so a 400 is already tagged.
export function moduleScope(name: string) {
  const setModule = Object.assign(
    () => {
      const context = getRequestContext()
      if (context !== undefined) context.module = name
    },
    { [MODULE_NAME]: name },
  )

  return new Elysia({ name: 'module-scope', seed: name }).onTransform({ as: 'scoped' }, setModule)
}

function declaredModules(controller: AnyElysia): string[] {
  const names: string[] = []
  for (const hook of controller.event.transform ?? []) {
    const name: unknown = Reflect.get(hook.fn, MODULE_NAME)
    if (typeof name === 'string') names.push(name)
  }
  return names
}

// Wraps a controller in the root app's `.use()` and fails startup when its log tag cannot be
// trusted: no `moduleScope`, or a name different from the controller's own (a typo). Returns
// the controller unchanged so Eden keeps its types.
export function mountModule<const T extends AnyElysia>(controller: T): T {
  const name = controller.config.name
  if (name === undefined || name === '') {
    throw new Error('A module controller must be named: new Elysia({ name: "<module>", prefix: "/<module>" })')
  }

  const declared = declaredModules(controller)
  if (declared.length === 0) {
    throw new Error(`Module "${name}" must start with .use(moduleScope("${name}"))`)
  }
  const wrong = declared.filter((declaredName) => declaredName !== name)
  if (wrong.length > 0) {
    throw new Error(`Module "${name}" uses moduleScope("${wrong.join('", "')}"); the name must match the module`)
  }
  return controller
}
