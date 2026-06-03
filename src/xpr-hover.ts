import { hoverTooltip } from '@codemirror/view'
import { BUILTINS } from './xpr-builtins'

// Disambiguate by call-site context: `foo.bar` -> prefer method receiver match;
// otherwise prefer global function/constant. Falls back to the first match so
// no builtin is ever silently dropped (e.g. `match` exists as both a global
// function and a string method).
function lookup(word: string, isDotted: boolean) {
  if (isDotted) {
    return (
      BUILTINS.find(b => b.name === word && b.kind === 'method') ??
      BUILTINS.find(b => b.name === word)
    )
  }
  return (
    BUILTINS.find(b => b.name === word && b.kind !== 'method') ??
    BUILTINS.find(b => b.name === word)
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const xprHover = hoverTooltip((view, pos, side) => {
  const { from, to, text } = view.state.doc.lineAt(pos)
  let start = pos
  let end = pos
  // Expand to identifier boundaries (\w = [A-Za-z0-9_]; `$` is not a valid XPR
  // identifier char per xpr-js tokenizer.ts:213-219).
  while (start > from && /\w/.test(text[start - from - 1] ?? '')) start--
  while (end < to && /\w/.test(text[end - from] ?? '')) end++
  if (start === end) return null
  if (start === pos && side < 0) return null
  if (end === pos && side > 0) return null

  const word = text.slice(start - from, end - from)
  const isDotted = start > from && text[start - from - 1] === '.'
  const builtin = lookup(word, isDotted)
  if (!builtin) return null

  return {
    pos: start,
    end,
    above: true,
    create() {
      const dom = document.createElement('div')
      dom.className = 'cm-hover-tooltip'
      dom.innerHTML =
        `<strong>${escapeHtml(builtin.signature)}</strong>` +
        `<br><span class="muted">${escapeHtml(builtin.description)}</span>` +
        `<br><small>since ${escapeHtml(builtin.version)}</small>`
      return { dom }
    },
  }
})
