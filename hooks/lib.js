// Pure text helpers for the language-improve mod: skip rules, the model's
// system prompt, the reply parser, a word diff and the band row layout.
// No `$`, no timers, no Node.

const MIN_WORDS = 3
const MAX_CHARS = 4000
const CODE_RATIO = 0.3
const MAX_DIFF_WORDS = 200
const CODE_SYMBOLS = new Set('{}[]()<>;=/\\|&$*_~^`#@%+'.split(''))

export const RULES = `You check English text that a non-native speaker is typing as a prompt to a coding assistant. Report real errors only: grammar (tense, agreement, articles, prepositions, word order), a wrong word, or spelling.

Ignore: code, file paths, identifiers, quoted text, URLs, chat-style capitalization, missing final punctuation, and dictation fillers or restarts ("uh", "um", a sentence started again).
If the text is not English, reply {"skip":true}.
If the text is a shell command, reply {"skip":true}, even when it contains prose such as a commit message or an echo string. A shell command begins with a command or program name followed by its arguments, for example: echo ..., git commit -m "...", ls -la, npm run ..., cd .... An ordinary English sentence that only mentions a command is not a shell command; check it normally.
Keep the writer's meaning and wording. Change the minimum needed to fix each error.
"original" and "corrected" are at most 40 words each. If the erroneous sentence is longer, quote only the clause of at most 40 words around the error.

Reply with JSON only, no other text, in one of these shapes:
{"ok":true}
{"skip":true}
{"count":<number of sentences with errors>,"last":{"original":"<exact sentence from the text>","corrected":"<the same sentence, fixed>","why":"<at most 8 words per change, joined by ' · '>"}}

"last" is the erroneous sentence nearest the end of the text.`

/** Runs of whitespace become one space; the ends are trimmed. */
export const normalizeWhitespace = (s) => s.replace(/\s+/g, ' ').trim()

const countWords = (s) => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length)

// The size skip rules: too few words, or mostly code symbols.
const tooSmallOrCode = (text) => {
  if (countWords(text) < MIN_WORDS) return true
  const chars = text.replace(/\s/g, '')
  let symbols = 0
  for (const ch of chars) if (CODE_SYMBOLS.has(ch)) symbols++
  return symbols / chars.length > CODE_RATIO
}

/**
 * Applies the skip rules and prepares the draft for the model.
 * Returns the text to send, or null to skip (make no call). The size rules
 * hold for the returned text, after the fences and the trailing cut.
 */
export const prepareDraft = (draft) => {
  const lead = draft.trimStart()
  if (lead.startsWith('/') || lead.startsWith('!')) return null

  // Fenced blocks go first so the prose around pasted code is still checked.
  // An unterminated fence runs to the end of the draft.
  let text = draft.replace(/```[\s\S]*?(?:```|$)/g, ' ').trim()
  if (tooSmallOrCode(text)) return null

  if (text.length > MAX_CHARS) {
    const tail = text.slice(-MAX_CHARS)
    // Cut forward to the start of the next sentence.
    const boundary = /[.!?](?:\s+)|\n\s*/.exec(tail)
    text = (boundary ? tail.slice(boundary.index + boundary[0].length) : tail).trim()
    if (tooSmallOrCode(text)) return null
  }
  return text
}

const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch)

/**
 * True when `quote` occurs in `text` as a run of 2 or more whole words: the
 * characters just outside the match are not word characters. Both are
 * expected whitespace-normalized.
 */
export const containsWordRun = (text, quote) => {
  if (countWords(quote) < 2) return false
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + quote.length] ?? ''
    if (!isWordChar(before) && !isWordChar(after)) return true
  }
  return false
}

// First balanced {...} object in the text, honouring JSON strings; null when
// there is none or it is cut off.
const firstObject = (reply) => {
  const start = reply.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < reply.length; i++) {
    const ch = reply[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return reply.slice(start, i + 1)
  }
  return null
}

/**
 * Parses the model's reply against the text that was sent.
 * Returns 'ok', 'skip', `{ original, corrected, why, more }`, or null (show nothing).
 */
export const parseReply = (reply, sentText) => {
  const json = firstObject(reply)
  if (json === null) return null
  let obj
  try {
    obj = JSON.parse(json)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object') return null
  if (obj.ok === true) return 'ok'
  if (obj.skip === true) return 'skip'

  let count = 1
  if ('count' in obj) {
    if (!Number.isInteger(obj.count) || obj.count < 0) return null
    if (obj.count === 0) return 'ok'
    count = obj.count
  }
  const last = obj.last
  if (last === null || typeof last !== 'object') return null
  if (typeof last.original !== 'string' || typeof last.corrected !== 'string' || typeof last.why !== 'string') return null

  const original = normalizeWhitespace(last.original)
  const corrected = normalizeWhitespace(last.corrected)
  if (original === '' || corrected === '' || corrected === original) return null
  if (!containsWordRun(normalizeWhitespace(sentText), original)) return null
  return { original, corrected, why: normalizeWhitespace(last.why), more: count - 1 }
}

/**
 * Word-level diff of original -> corrected.
 * Returns the corrected words as `{ word, changed }`; `changed` marks words
 * inserted or replaced. A deletion leaves nothing to mark. Over 200 words on
 * either side, nothing is marked.
 */
export const diffWords = (original, corrected) => {
  const a = original.split(/\s+/).filter(Boolean)
  const b = corrected.split(/\s+/).filter(Boolean)
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return b.map((word) => ({ word, changed: false }))
  }
  // lcs[i][j] = longest common subsequence length of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      out.push({ word: b[j], changed: false })
      i++
      j++
    } else if (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++
    } else {
      out.push({ word: b[j], changed: true })
      j++
    }
  }
  return out
}

const DIM = { dimColor: true }
const ACCENT = { color: 'suggestion' }
const CHANGED = { color: 'diffAddedWord', bold: true }

// The corrected sentence as segments: runs of equal styling merged.
const sentenceSegments = (original, corrected) => {
  const segments = []
  for (const { word, changed } of diffWords(original, corrected)) {
    const style = changed ? CHANGED : {}
    const prev = segments[segments.length - 1]
    if (prev && prev.changed === changed) prev.text += ` ${word}`
    else segments.push({ text: segments.length ? ` ${word}` : word, style, changed })
  }
  return segments.map(({ text, style }) => ({ text, style }))
}

const row = (segments) => ({ wrap: 'truncate-end', segments })

/**
 * Lays out the band in the look of the built-in you-should-know band: an
 * accent glyph, a dim tag, then the text, with the reason under a 2-space
 * indent. Rows are styled segments, each meant for `wrap: 'truncate-end'`.
 * view: `{ kind: 'ok', source }` | `{ kind: 'fix', source, original, corrected, why, more }`
 * (`source`: 'draft' | 'sent'). Returns `{ gap, rows }`: `gap` asks for one
 * blank row above the rows. `rows.length + (gap ? 1 : 0)` never exceeds
 * `maxRows`; the gap is dropped first, then the reason row.
 */
export const bandRows = (view, { maxRows }) => {
  if (maxRows <= 0) return { gap: false, rows: [] }
  const tag = { text: view.source === 'sent' ? 'English · sent · ' : 'English · ', style: DIM }
  if (view.kind === 'ok') {
    return {
      gap: maxRows >= 2,
      rows: [row([{ text: '✓ ', style: ACCENT }, tag, { text: 'no errors', style: DIM }])],
    }
  }
  const first = [{ text: '✎ ', style: ACCENT }, tag, ...sentenceSegments(view.original, view.corrected)]
  if (view.more > 0) first.push({ text: `  +${view.more} more`, style: DIM })
  if (maxRows < 2) return { gap: false, rows: [row([...first, { text: ` · ${view.why}`, style: DIM }])] }
  return {
    gap: maxRows >= 3,
    rows: [row(first), row([{ text: '  ', style: {} }, { text: view.why, style: DIM }])],
  }
}
