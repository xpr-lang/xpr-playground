import type { CompletionSource } from '@codemirror/autocomplete'
import { BUILTINS } from './xpr-builtins'

const METHODS = BUILTINS.filter(b => b.kind === 'method')
const GLOBALS = BUILTINS.filter(b => b.kind === 'function' || b.kind === 'constant')

const METHOD_OPTIONS = METHODS.map(m => ({
  label: m.name,
  type: 'method' as const,
  info: m.signature,
  detail: m.description,
}))

const GLOBAL_OPTIONS = GLOBALS.map(g => ({
  label: g.name,
  type: g.kind === 'constant' ? ('constant' as const) : ('function' as const),
  info: g.signature,
  detail: g.description,
}))

export const xprCompletions: CompletionSource = (context) => {
  const dotMatch = context.matchBefore(/\.\w*/)
  if (dotMatch) {
    return {
      from: dotMatch.from + 1,
      options: METHOD_OPTIONS,
      validFor: /^\w*$/,
    }
  }

  const word = context.matchBefore(/\w*/)
  if (!word || (word.from === word.to && !context.explicit)) return null

  return {
    from: word.from,
    options: GLOBAL_OPTIONS,
    validFor: /^\w*$/,
  }
}
