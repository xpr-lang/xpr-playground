import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { StringStream } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const XPR_KEYWORDS = new Set(['let', 'true', 'false', 'null'])

interface XprState {
  inString: string | null // null, '"', "'", or '`'
}

const xprStreamLanguage = StreamLanguage.define<XprState>({
  name: 'xpr',
  startState(): XprState {
    return { inString: null }
  },
  token(stream: StringStream, state: XprState): string | null {
    if (state.inString) {
      const quote = state.inString
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next()
        } else if (ch === quote) {
          state.inString = null
          break
        }
      }
      return 'string'
    }

    if (stream.eatSpace()) return null

    const ch = stream.peek()

    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next()
      state.inString = ch
      while (!stream.eol()) {
        const c = stream.next()
        if (c === '\\') {
          stream.next()
        } else if (c === ch) {
          state.inString = null
          break
        }
      }
      return 'string'
    }

    if (ch && /[0-9]/.test(ch)) {
      stream.match(/^[0-9]+(\.[0-9]+)?/)
      return 'number'
    }

    if (ch && /[a-zA-Z_$]/.test(ch)) {
      stream.match(/^[a-zA-Z_$0-9]*/)
      const word = stream.current()
      if (XPR_KEYWORDS.has(word)) return 'keyword'
      return 'variableName'
    }

    if (stream.match('...')) return 'operator'

    if (ch && /[+\-*/%=<>!&|^~?:.]/.test(ch)) {
      stream.match(/^[+\-*/%=<>!&|^~?:.]+/)
      return 'operator'
    }

    if (ch && /[()[\]{},;]/.test(ch)) {
      stream.next()
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
])

export const xprLanguage = [xprStreamLanguage, syntaxHighlighting(xprHighlightStyle)]
