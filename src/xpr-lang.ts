import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { StringStream } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Reserved identifiers per xpr-js/src/tokenizer.ts:247-249.
// XPR has only four reserved words; every other distinct entry in TokenType
// is an operator or punctuation pattern handled directly in token() below.
const XPR_KEYWORDS = new Set(['let', 'true', 'false', 'null'])

// Among the four keywords, only true/false/null are value-producing. `let`
// introduces a binding, so a following `/` (e.g. `let r = /…/`) should be
// treated as a regex literal — that flows through the `=` operator anyway,
// but keeping this set explicit documents intent.
const VALUE_KEYWORDS = new Set(['true', 'false', 'null'])

interface XprState {
  // Active sub-tokenizer.
  // - 'normal':       generic expression tokens.
  // - 'string':       inside a "…" or '…' literal that spans token() calls.
  // - 'template':     inside a `…` template literal, reading text portion.
  // - 'templateExpr': inside a ${…} interpolation of a template literal.
  mode: 'normal' | 'string' | 'template' | 'templateExpr'
  // Quote character active when mode === 'string'.
  quote: string | null
  // Brace depth while mode === 'templateExpr'. ${ opens at depth 1; an
  // inner { increments, } decrements; the } that drops depth back to 0
  // returns to 'template' mode.
  exprDepth: number
  // True iff the most recently emitted significant token was value-producing
  // (number, string, template, regex, identifier, closing bracket). Drives
  // the regex-vs-division decision when a `/` is encountered. Mirrors
  // REGEX_AFTER in xpr-js's tokenizer: `/` is a regex literal when this is
  // false.
  lastWasValue: boolean
}

function consumeString(stream: StringStream, quote: string): boolean {
  while (!stream.eol()) {
    const c = stream.next()
    if (c === '\\') {
      if (!stream.eol()) stream.next()
      continue
    }
    if (c === quote) return true
  }
  return false
}

function consumeRegex(stream: StringStream): void {
  // Opening `/` already consumed by caller. Read body until an unescaped,
  // non-character-class `/`, then sweep any trailing flags.
  let inClass = false
  while (!stream.eol()) {
    const c = stream.next()
    if (c === '\\') {
      if (!stream.eol()) stream.next()
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      // Flags per xpr-js readRegex() ([imsgu]); also allow JS's `y`.
      stream.match(/^[gimsuy]+/)
      return
    }
  }
}

function consumeTemplateText(stream: StringStream): void {
  // Read template-literal text up to (but not consuming) the next `${`,
  // the closing backtick, or end-of-line.
  while (!stream.eol()) {
    const ch = stream.peek()
    if (ch === '`') return
    if (ch === '$' && stream.string.charAt(stream.pos + 1) === '{') return
    if (ch === '\\') {
      stream.next()
      if (!stream.eol()) stream.next()
      continue
    }
    stream.next()
  }
}

const xprStreamLanguage = StreamLanguage.define<XprState>({
  name: 'xpr',

  startState(): XprState {
    return { mode: 'normal', quote: null, exprDepth: 0, lastWasValue: false }
  },

  token(stream: StringStream, state: XprState): string | null {
    if (state.mode === 'string' && state.quote) {
      if (consumeString(stream, state.quote)) {
        state.mode = 'normal'
        state.quote = null
        state.lastWasValue = true
      }
      return 'string'
    }

    if (state.mode === 'template') {
      const ch = stream.peek()
      if (ch === '`') {
        stream.next()
        state.mode = 'normal'
        state.lastWasValue = true
        return 'string'
      }
      if (ch === '$' && stream.string.charAt(stream.pos + 1) === '{') {
        stream.next()
        stream.next()
        state.mode = 'templateExpr'
        state.exprDepth = 1
        return 'punctuation'
      }
      consumeTemplateText(stream)
      return 'string'
    }

    if (stream.eatSpace()) return null

    const ch = stream.peek()
    if (!ch) return null

    if (ch === '"' || ch === "'") {
      stream.next()
      if (consumeString(stream, ch)) {
        state.lastWasValue = true
      } else {
        state.mode = 'string'
        state.quote = ch
      }
      return 'string'
    }

    if (ch === '`') {
      stream.next()
      state.mode = 'template'
      return 'string'
    }

    if (/[0-9]/.test(ch)) {
      stream.match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)
      state.lastWasValue = true
      return 'number'
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      stream.match(/^[a-zA-Z_$0-9]*/)
      const word = stream.current()
      if (XPR_KEYWORDS.has(word)) {
        state.lastWasValue = VALUE_KEYWORDS.has(word)
        return 'keyword'
      }
      state.lastWasValue = true
      return 'variableName'
    }

    // Multi-character operators — longest-match first.
    // Covers v0.2+ spread (...), v0.3+ pipe (|>), v0.3+ nullish (??),
    // optional chain (?.), arrow (=>), exponent (**), and JS comparisons.
    if (
      stream.match('...') ||
      stream.match('**') ||
      stream.match('==') ||
      stream.match('!=') ||
      stream.match('<=') ||
      stream.match('>=') ||
      stream.match('&&') ||
      stream.match('||') ||
      stream.match('??') ||
      stream.match('?.') ||
      stream.match('|>') ||
      stream.match('=>')
    ) {
      state.lastWasValue = false
      return 'operator'
    }

    if (ch === '/') {
      stream.next()
      if (!state.lastWasValue) {
        consumeRegex(stream)
        state.lastWasValue = true
        return 'regexp'
      }
      state.lastWasValue = false
      return 'operator'
    }

    // `.`, `,`, `:`, `;` are intentionally absent from this class — they are
    // punctuation, so `user.name` does NOT colour the dot as an operator.
    if (/[+\-*%=<>!&|^~?]/.test(ch)) {
      stream.next()
      state.lastWasValue = false
      return 'operator'
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stream.next()
      if (state.mode === 'templateExpr' && ch === '{') state.exprDepth++
      state.lastWasValue = false
      return 'punctuation'
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      stream.next()
      if (state.mode === 'templateExpr' && ch === '}') {
        state.exprDepth--
        if (state.exprDepth === 0) {
          state.mode = 'template'
          state.lastWasValue = false
          return 'punctuation'
        }
      }
      state.lastWasValue = true
      return 'punctuation'
    }

    if (/[.,:;]/.test(ch)) {
      stream.next()
      state.lastWasValue = false
      return 'punctuation'
    }

    stream.next()
    return null
  },

  tokenTable: {
    keyword: tags.keyword,
    string: tags.string,
    number: tags.number,
    operator: tags.operator,
    variableName: tags.variableName,
    punctuation: tags.punctuation,
    regexp: tags.regexp,
  },
  languageData: {
    commentTokens: { line: '//' },
  },
})

export const xprHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--purple)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--green)' },
  { tag: tags.number, color: 'var(--orange)' },
  { tag: tags.operator, color: 'var(--accent)' },
  { tag: tags.variableName, color: 'var(--text)' },
  { tag: tags.punctuation, color: 'var(--text-muted)' },
  { tag: tags.regexp, color: 'var(--green)' },
])

export const xprLanguage = [xprStreamLanguage, syntaxHighlighting(xprHighlightStyle)]
