// Pure text helpers for the language-improve mod: skip rules, the model's
// system prompt, the reply parser, a word diff and the band row layout.
// No `$`, no timers, no Node.

const MIN_WORDS = 3
const MAX_CHARS = 4000
const CODE_RATIO = 0.3
const MAX_DIFF_WORDS = 200
const CODE_SYMBOLS = new Set('{}[]()<>;=/\\|&$*_~^`#@%+'.split(''))

/** Error kinds the model labels each change with, and the muted list stores. */
export const KINDS = [
  { slug: 'article', label: 'articles' },
  { slug: 'preposition', label: 'prepositions' },
  { slug: 'verb-form', label: 'verb forms' },
  { slug: 'agreement', label: 'agreement' },
  { slug: 'word-order', label: 'word order' },
  { slug: 'word-choice', label: 'word choice' },
  { slug: 'number', label: 'plural/singular' },
  { slug: 'pronoun', label: 'pronouns' },
  { slug: 'apostrophe', label: 'apostrophes' },
  { slug: 'comma', label: 'commas' },
  { slug: 'spelling', label: 'spelling' },
  { slug: 'capitalization', label: 'capitalization' },
]

const MAX_ERRORS = 8
const MAX_CHANGES = 6

/**
 * The model's system prompt. `muted` is a list of kind slugs; a non-empty list
 * adds a line telling the model to leave those kinds out.
 */
export const systemPrompt = (muted = []) => {
  const labels = KINDS.filter((k) => muted.includes(k.slug)).map((k) => k.label)
  const mutedLine = labels.length ? `\nDo not report or fix these kinds: ${labels.join(', ')}.` : ''
  return `You check English text that a non-native speaker is typing as a prompt to a coding assistant. Report real errors only: grammar (tense, agreement, articles, prepositions, word order), a wrong word, or spelling.

Ignore: code, file paths, identifiers, quoted text, URLs, chat-style capitalization, missing final punctuation, and dictation fillers or restarts ("uh", "um", a sentence started again).
If the text is not English, reply {"skip":true}.
If the text is a shell command, reply {"skip":true}, even when it contains prose such as a commit message or an echo string. A shell command begins with a command or program name followed by its arguments, for example: echo ..., git commit -m "...", ls -la, npm run ..., cd .... An ordinary English sentence that only mentions a command is not a shell command; check it normally.
Keep the writer's meaning and wording. Change the minimum needed to fix each error.
"original" and "corrected" are at most 40 words each. If the erroneous sentence is longer, quote only the clause of at most 40 words around the error.${mutedLine}

Reply with JSON only, no other text, in one of these shapes:
{"ok":true}
{"skip":true}
{"errors":[{"original":"<exact sentence from the text>","corrected":"<the same sentence, fixed>","changes":[{"kind":"<kind>","why":"<at most 8 words>"}]}]}

List each erroneous sentence once, in the order it appears in the text, at most ${MAX_ERRORS} errors. "changes" has one entry for each fix in that sentence.
"kind" is one of: ${KINDS.map((k) => k.slug).join(', ')}, other.`
}

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

const KIND_SLUGS = new Set(KINDS.map((k) => k.slug))

// One change from the reply, or null when it has no string `why`.
const parseChange = (change) => {
  if (change === null || typeof change !== 'object' || typeof change.why !== 'string') return null
  return { kind: KIND_SLUGS.has(change.kind) ? change.kind : 'other', why: normalizeWhitespace(change.why) }
}

// One error from the reply, or null when it is not usable against `sent`.
const parseError = (error, sent) => {
  if (error === null || typeof error !== 'object') return null
  if (typeof error.original !== 'string' || typeof error.corrected !== 'string') return null
  const original = normalizeWhitespace(error.original)
  const corrected = normalizeWhitespace(error.corrected)
  if (original === '' || corrected === '' || corrected === original) return null
  if (!containsWordRun(sent, original)) return null
  const changes = (Array.isArray(error.changes) ? error.changes : []).map(parseChange).filter(Boolean)
  if (changes.length === 0) return null
  return { original, corrected, changes: changes.slice(0, MAX_CHANGES) }
}

/**
 * Parses the model's reply against the text that was sent.
 * Returns 'ok', 'skip', `{ errors: [{ original, corrected, changes: [{ kind, why }] }] }`,
 * or null (show nothing). Each error is checked on its own; unusable ones are
 * dropped, and at most 8 are kept.
 */
export const parseErrors = (reply, sentText) => {
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
  if (!Array.isArray(obj.errors)) return null
  if (obj.errors.length === 0) return 'ok'

  const sent = normalizeWhitespace(sentText)
  const errors = []
  for (const raw of obj.errors) {
    const error = parseError(raw, sent)
    if (error && !errors.some((e) => e.original === error.original)) errors.push(error)
    if (errors.length === MAX_ERRORS) break
  }
  return errors.length ? { errors } : null
}

/**
 * LCS alignment of two word lists as ops `{ type, i, j }`: `eq` (a[i] = b[j]),
 * `del` (a[i] left out) and `ins` (b[j] added). Every word of `a` is in one
 * `eq` or `del` and every word of `b` in one `eq` or `ins`, in order.
 */
export const alignWords = (a, b) => {
  // lcs[i][j] = longest common subsequence length of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      ops.push({ type: 'eq', i, j })
      i++
      j++
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ type: 'del', i, j })
      i++
    } else {
      ops.push({ type: 'ins', i, j })
      j++
    }
  }
  return ops
}

const wordsOf = (text) => text.split(/\s+/).filter(Boolean)

// Only the apostrophes (' and ’) tell these two words apart, case aside.
const apostropheOnly = (x, y) => {
  const bare = (w) => w.replace(/['’]/g, '').toLowerCase()
  return x.toLowerCase() !== y.toLowerCase() && bare(x) === bare(y)
}

/**
 * `corrected` with each apostrophe-only edit put back to the original word.
 * Each deleted word is matched to the first unused inserted word that differs
 * from it by apostrophes only, anywhere in the error, so a word the fix moved
 * is matched too. Over 200 words on either side, no revert. Returns
 * `{ corrected, words }`: `corrected` itself when nothing was reverted, and
 * the lower-cased original and corrected forms of each reverted word.
 */
const revertApostrophes = (original, corrected) => {
  const a = wordsOf(original)
  const b = wordsOf(corrected)
  const words = []
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) return { corrected, words }
  const out = [...b]
  const dels = []
  const free = []
  for (const op of alignWords(a, b)) {
    if (op.type === 'del') dels.push(op.i)
    else if (op.type === 'ins') free.push(op.j)
  }
  for (const i of dels) {
    const at = free.findIndex((j) => apostropheOnly(a[i], b[j]))
    if (at < 0) continue
    const [j] = free.splice(at, 1)
    out[j] = a[i]
    words.push(a[i].toLowerCase(), b[j].toLowerCase())
  }
  return { corrected: words.length ? out.join(' ') : corrected, words }
}

// Whether a reason names a reverted word (either form) or talks of apostrophes.
const describesRevert = (why, words) =>
  /apostrophe|contraction/i.test(why) ||
  (why.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]*)*/gu) ?? []).some((w) => words.includes(w.toLowerCase().replace(/’/g, "'")))

/**
 * The errors to draw: changes of muted kinds are dropped, then errors left
 * with no change. `muted` is a list of kind slugs. With `apostrophe` muted, a
 * code check also puts back each apostrophe-only edit, whatever its label, and
 * drops the changes whose reason describes a reverted word; an error whose
 * corrected text then equals its original is dropped, while one that still
 * differs stays even with no change left.
 */
export const visibleErrors = (errors, muted) => {
  const visible = errors
    .map((e) => ({ ...e, changes: e.changes.filter((c) => !muted.includes(c.kind)) }))
    .filter((e) => e.changes.length > 0)
  if (!muted.includes('apostrophe')) return visible
  return visible
    .map((e) => {
      const { corrected, words } = revertApostrophes(e.original, e.corrected)
      if (words.length === 0) return e
      return { ...e, corrected, changes: e.changes.filter((c) => !describesRevert(c.why, words)) }
    })
    .filter((e) => wordsOf(e.corrected).join(' ') !== wordsOf(e.original).join(' '))
}

/**
 * Word-level diff of original -> corrected.
 * Returns the corrected words as `{ word, changed }`; `changed` marks words
 * inserted or replaced. A deletion leaves nothing to mark. Over 200 words on
 * either side, nothing is marked.
 */
export const diffWords = (original, corrected) => {
  const a = wordsOf(original)
  const b = wordsOf(corrected)
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return b.map((word) => ({ word, changed: false }))
  }
  return alignWords(a, b)
    .filter((op) => op.type !== 'del')
    .map((op) => ({ word: b[op.j], changed: op.type === 'ins' }))
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
const reasonsRow = (error) =>
  row([{ text: '  ', style: {} }, { text: error.changes.map((c) => c.why).join(' · '), style: DIM }])

const KIND_LABELS = new Map(KINDS.map((k) => [k.slug, k.label]))
const PAGE_SIZE = 3
const MUTE_HOTKEYS = 'asdfghjkl'
const HINT = 'ctrl+x tab'
const ACTION_INDENT = 2
const ACTION_GAP = 2

// Today's compact form for fewer than 3 rows, or when the action row does not
// fit: the first error with `+N more`, then its reasons (inline at one row).
const compactRows = (errors, tag, maxRows) => {
  const [error, ...others] = errors
  const why = error.changes.map((c) => c.why).join(' · ')
  const first = [{ text: '✎ ', style: ACCENT }, tag, ...sentenceSegments(error.original, error.corrected)]
  if (others.length > 0) first.push({ text: `  +${others.length} more`, style: DIM })
  if (maxRows < 2) return { gap: false, rows: [row(why ? [...first, { text: ` · ${why}`, style: DIM }] : first)], page: 0, pages: 1 }
  return { gap: maxRows >= 3, rows: [row(first), reasonsRow(error)], page: 0, pages: 1 }
}

// The distinct muteable kinds of these errors, in order of appearance.
const muteableKinds = (errors) => {
  const slugs = []
  for (const e of errors) for (const c of e.changes) if (KIND_LABELS.has(c.kind) && !slugs.includes(c.kind)) slugs.push(c.kind)
  return slugs.slice(0, MUTE_HOTKEYS.length)
}

/**
 * The action row for one page: `{ actions, hint, pageText }`; `null` when it
 * has nothing to press (one page, only `other` kinds); `false` when the page
 * text with `n`/`p` does not fit `columns`. Too wide: the hint goes first,
 * then the mute buttons from the end.
 */
const actionRow = (errors, page, pages, columns) => {
  const paged = pages > 1
  const actions = paged
    ? [
        { key: 'page:next', hotkey: 'n', label: 'next' },
        { key: 'page:back', hotkey: 'p', label: 'back' },
      ]
    : []
  const mutes = muteableKinds(errors).map((slug, i) => ({
    key: `mute:${slug}`,
    hotkey: MUTE_HOTKEYS[i],
    label: `mute ${KIND_LABELS.get(slug)}`,
  }))
  if (!paged && mutes.length === 0) return null
  const pageText = paged ? `‹ ${page + 1}/${pages} ›` : undefined
  const width = (acts, hint) =>
    ACTION_INDENT +
    [pageText, ...acts.map((a) => `${a.hotkey}: ${a.label}`), hint]
      .filter(Boolean)
      .map((t) => t.length)
      .reduce((sum, w, i) => sum + w + (i > 0 ? ACTION_GAP : 0), 0)
  let hint = HINT
  let keep = mutes.length
  if (width([...actions, ...mutes], hint) > columns) hint = undefined
  while (keep > 0 && width([...actions, ...mutes.slice(0, keep)], hint) > columns) keep--
  const shown = [...actions, ...mutes.slice(0, keep)]
  if (width(shown, hint) > columns || shown.length === 0) return false
  return { actions: shown, hint, pageText }
}

/**
 * Lays out the band in the look of the built-in you-should-know band: an
 * accent glyph, a dim tag, then the text, with the reasons under a 2-space
 * indent. Text rows are styled segments `{ wrap, segments }`, each meant for
 * `wrap: 'truncate-end'`; the action row is `{ actions: [{ key, hotkey, label }],
 * hint, pageText }` (Buttons plus dim text).
 * view: `{ kind: 'ok', source }` | `{ kind: 'fix', source, errors }`
 * (`source`: 'draft' | 'sent'). `muted` (kind slugs) is filtered out of the
 * errors; with none left the band reads "no errors". `page` is zero-based and
 * clamped. `bodyColumns` is the width for the action row (unbounded when left out).
 * Returns `{ gap, rows, page, pages }` (`page` the clamped page): `gap` asks for
 * one blank row above the rows. `rows.length + (gap ? 1 : 0)` never exceeds
 * `maxRows`. The budget drops the gap first, then the page size (3 down to 1);
 * under 3 rows, or when the action row is too wide, the compact form is used:
 * the first error with `+N more` and its reasons, with no Buttons.
 */
export const bandRows = (view, { maxRows, bodyColumns = Infinity, muted = [], page = 0 }) => {
  if (maxRows <= 0) return { gap: false, rows: [], page: 0, pages: 1 }
  const tag = { text: view.source === 'sent' ? 'English · sent · ' : 'English · ', style: DIM }
  const errors = view.kind === 'fix' ? visibleErrors(view.errors, muted) : []
  if (errors.length === 0) {
    return {
      gap: maxRows >= 2,
      rows: [row([{ text: '✓ ', style: ACCENT }, tag, { text: 'no errors', style: DIM }])],
      page: 0,
      pages: 1,
    }
  }
  if (maxRows < 3) return compactRows(errors, tag, maxRows)

  // Rows one page of `size` errors takes, the action row included.
  const need = (size) => {
    const pages = Math.ceil(errors.length / size)
    return 2 * Math.min(size, errors.length) + (pages > 1 || muteableKinds(errors).length > 0 ? 1 : 0)
  }
  const full = Math.min(PAGE_SIZE, errors.length)
  let size = full
  while (size > 1 && need(size) > maxRows) size--
  const pages = Math.ceil(errors.length / size)
  const current = Math.min(Math.max(page, 0), pages - 1)
  const shown = errors.slice(current * size, (current + 1) * size)
  const actions = actionRow(shown, current, pages, bodyColumns)
  if (actions === false) return compactRows(errors, tag, maxRows)

  const rows = shown.flatMap((error, i) => [
    row([{ text: '✎ ', style: ACCENT }, ...(i === 0 ? [tag] : []), ...sentenceSegments(error.original, error.corrected)]),
    reasonsRow(error),
  ])
  if (actions !== null) rows.push(actions)
  return { gap: size === full && need(full) + 1 <= maxRows, rows, page: current, pages }
}
