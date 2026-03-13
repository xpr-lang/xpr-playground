import { StreamLanguage } from '@codemirror/language'
import type { StringStream } from '@codemirror/language'

const XPR_KEYWORDS = new Set(['let', 'true', 'false', 'null'])

interface XprState {
  inString: string | null // null, '"', "'", or '`'
}

export const xprLanguage = StreamLanguage.define<XprState>({
  name: 'xpr',
  startState(): XprState {
    return { inString: null }
  },
  token(stream: StringStream, state: XprState): string | null {
    // Inside a string
    if (state.inString) {
      const quote = state.inString
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next() // skip escaped char
        } else if (ch === quote) {
          state.inString = null
          break
        }
      }
      return 'string'
    }

    // Skip whitespace
    if (stream.eatSpace()) return null

    const ch = stream.peek()

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next()
      state.inString = ch
      // consume rest of string on same line
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

    // Numbers
    if (ch && /[0-9]/.test(ch)) {
      stream.match(/^[0-9]+(\.[0-9]+)?/)
      return 'number'
    }

    // Identifiers and keywords
    if (ch && /[a-zA-Z_$]/.test(ch)) {
      stream.match(/^[a-zA-Z_$0-9]*/)
      const word = stream.current()
      if (XPR_KEYWORDS.has(word)) return 'keyword'
      return 'variableName'
    }

    // Spread operator (must check before single-char operators)
    if (stream.match('...')) return 'operator'

    // Operators
    if (ch && /[+\-*/%=<>!&|^~?:.]/.test(ch)) {
      stream.match(/^[+\-*/%=<>!&|^~?:.]+/)
      return 'operator'
    }

    // Punctuation
    if (ch && /[()[\]{},;]/.test(ch)) {
      stream.next()
      return 'punctuation'
    }

    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '//' },
  },
})
