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

/**
 * Error groups, one color each, as `{ slug, label, color, kinds }`. `color` is
 * a theme key. Each of the 12 kinds is in one group; `other` is in none.
 */
export const GROUPS = [
  { slug: 'grammar', label: 'grammar', color: 'warning', kinds: ['verb-form', 'agreement', 'number', 'pronoun'] },
  { slug: 'small-words', label: 'small words', color: 'ide', kinds: ['article', 'preposition'] },
  { slug: 'wording', label: 'wording', color: 'autoAccept', kinds: ['word-choice', 'word-order'] },
  { slug: 'spelling', label: 'spelling', color: 'success', kinds: ['spelling', 'capitalization'] },
  { slug: 'punctuation', label: 'punctuation', color: 'claude', kinds: ['apostrophe', 'comma'] },
]

/** The group of an error kind, or null for `other` and unknown kinds. */
export const groupOf = (kind) => GROUPS.find((g) => g.kinds.includes(kind)) ?? null

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
{"errors":[{"original":"<exact sentence from the text>","corrected":"<the same sentence, fixed>","changes":[{"kind":"<kind>","words":"<the words of corrected this fix wrote>","why":"<at most 8 words>"}]}]}

List each erroneous sentence once, in the order it appears in the text, at most ${MAX_ERRORS} errors. "changes" has one entry for each fix in that sentence. "words" is the words of "corrected" that the fix wrote, copied exactly; empty when the fix only removes words.
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

// Index of the first occurrence of `quote` in `text` at or after `from` as
// whole words: the characters just outside the match are not word characters.
// -1 when there is none.
const findWordRun = (text, quote, from) => {
  for (let at = text.indexOf(quote, from); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + quote.length] ?? ''
    if (!isWordChar(before) && !isWordChar(after)) return at
  }
  return -1
}

/**
 * True when `quote` occurs in `text` as a run of 2 or more whole words: the
 * characters just outside the match are not word characters. Both are
 * expected whitespace-normalized.
 */
export const containsWordRun = (text, quote) => countWords(quote) >= 2 && findWordRun(text, quote, 0) >= 0

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

// One change from the reply, or null when it has no string `why`. `words` is
// kept only when it is a non-empty string.
const parseChange = (change) => {
  if (change === null || typeof change !== 'object' || typeof change.why !== 'string') return null
  const parsed = { kind: KIND_SLUGS.has(change.kind) ? change.kind : 'other', why: normalizeWhitespace(change.why) }
  const words = typeof change.words === 'string' ? normalizeWhitespace(change.words) : ''
  return words === '' ? parsed : { ...parsed, words }
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
 * Returns 'ok', 'skip', `{ errors: [{ original, corrected, changes: [{ kind, why, words? }] }] }`,
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

// The corrected words as `{ word, changed }`, and `removedAt`: for each deleted
// word, how many corrected words come before it. Over 200 words either side: nothing marked.
const diffMarks = (original, corrected) => {
  const a = wordsOf(original)
  const b = wordsOf(corrected)
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) return { words: b.map((word) => ({ word, changed: false })), removedAt: [] }
  const words = []
  const removedAt = []
  for (const op of alignWords(a, b)) {
    if (op.type === 'del') removedAt.push(words.length)
    else words.push({ word: b[op.j], changed: op.type === 'ins' })
  }
  return { words, removedAt }
}

/**
 * Word-level diff of original -> corrected.
 * Returns the corrected words as `{ word, changed }`; `changed` marks words
 * inserted or replaced. A deletion leaves nothing to mark. Over 200 words on
 * either side, nothing is marked.
 */
export const diffWords = (original, corrected) => diffMarks(original, corrected).words

const DIM = { dimColor: true }
const ACCENT = { color: 'suggestion' }

const CONTEXT = 4
const MIN_COLUMNS = 20
const ELLIPSIS = '…'
const NEUTRAL = { bold: true }

// A word without the punctuation round it, lower-cased; a word of punctuation only stays whole.
const bareWord = (w) => (w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || w).toLowerCase()

// The style of one changed word of `visible`, whose unreverted original is `raw`.
const changedStyle = (word, raw, visible, muted) => {
  const key = bareWord(word)
  const hit = raw.changes.find((c) => c.words !== undefined && wordsOf(c.words).some((w) => bareWord(w) === key))
  if (hit) {
    if (muted.includes(hit.kind)) return {}
    const group = groupOf(hit.kind)
    return group ? { color: group.color, bold: true } : NEUTRAL
  }
  if (visible.changes.length === 0 || raw.changes.some((c) => muted.includes(c.kind))) return NEUTRAL
  const groups = new Set(raw.changes.map((c) => groupOf(c.kind)))
  const [only] = groups
  return groups.size === 1 && only ? { color: only.color, bold: true } : NEUTRAL
}

/**
 * The draft with the fixes of the visible errors spliced in, as tokens
 * `{ text, space, style }`: `space` says whether one space precedes the token,
 * and tokens also break at the edges of a splice, so text kept next to a fix
 * (`text,` or `(I`) keeps its exact characters. `text` and the raw `errors`
 * are the view's; `muted` is a list of kind slugs. Each visible error goes at
 * the first whole-word occurrence of its `original` at or after the end of the
 * one before; one that is not found changes no text. A changed word is styled
 * from the raw change whose `words` holds it: its group's color and bold; plain
 * for a muted kind; bold alone for `other`. With no such change, the group
 * shared by all the raw changes of its error (none muted) colors it, else bold
 * alone. Unchanged tokens farther than 4 from a changed one, or from the place
 * of a removal (which draws no mark), become one dim `…` per stretch; a stretch
 * of one token is shown. With neither, the first 8 tokens are kept and the rest
 * become one `…` (nothing is cut at 9 tokens or fewer).
 */
export const fixedTokens = (text, errors, muted) => {
  const tokens = []
  let space = false
  // Unchanged text, cut at its spaces; a space at either end waits for the next token.
  const pushText = (s) => {
    s.split(' ').forEach((part, k) => {
      if (k > 0) space = true
      if (part === '') return
      tokens.push({ text: part, space, style: {}, changed: false })
      space = false
    })
  }

  const removals = []
  let cursor = 0
  for (const raw of errors) {
    for (const visible of visibleErrors([raw], muted)) {
      const at = findWordRun(text, visible.original, cursor)
      if (at < 0) continue
      pushText(text.slice(cursor, at))
      const { words, removedAt } = diffMarks(visible.original, visible.corrected)
      removedAt.forEach((k) => removals.push(tokens.length + k))
      words.forEach(({ word, changed }, k) => {
        const style = changed ? changedStyle(word, raw, visible, muted) : {}
        tokens.push({ text: word, space: k > 0 || space, style, changed })
      })
      space = false
      cursor = at + visible.original.length
    }
  }
  pushText(text.slice(cursor))

  const keep = tokens.map(() => false)
  const around = (from, to) => keep.fill(true, Math.max(0, from), Math.min(tokens.length, to))
  tokens.forEach((t, i) => {
    if (t.changed) around(i - CONTEXT, i + CONTEXT + 1)
  })
  // A removal leaves no token: the point between the tokens either side of it is the centre.
  removals.forEach((p) => around(p - CONTEXT, p + CONTEXT))
  if (!keep.includes(true)) around(0, 2 * CONTEXT)
  // A `…` hides at least two tokens: a stretch of one stays.
  keep.forEach((k, i) => {
    if (!k && (i === 0 || keep[i - 1]) && (i === keep.length - 1 || keep[i + 1])) keep[i] = true
  })
  const shown = []
  tokens.forEach((t, i) => {
    if (keep[i]) shown.push({ text: t.text, space: t.space, style: t.style })
    else if (i === 0 || keep[i - 1]) shown.push({ text: ELLIPSIS, space: t.space, style: DIM })
  })
  return shown
}

/**
 * Greedy line wrap of tokens `{ text, space, style }` into lines of tokens.
 * A token with no space before it stays on the line of the one before it,
 * unless it has `breakBefore: true` (the line may break there, with no space). The
 * first line holds the tokens from the start, so put the `✎ ` and tag tokens
 * first; the lines after it start after `indent` columns, which the caller
 * prints. A token at a line start has `space: false`. Width counts `.length`;
 * `columns` under 20 is read as 20. A token wider than a line gets a line to
 * itself.
 */
export const wrapTokens = (tokens, columns, indent) => {
  const limit = Math.max(columns, MIN_COLUMNS)
  const units = []
  for (const t of tokens) {
    if (units.length > 0 && !t.space && !t.breakBefore) units[units.length - 1].push(t)
    else units.push([t])
  }
  const lines = [[]]
  let used = 0
  for (const unit of units) {
    const width = unit.reduce((sum, t) => sum + t.text.length, 0)
    let line = lines[lines.length - 1]
    let lead = line.length > 0 && unit[0].space ? 1 : 0
    if (line.length > 0 && used + lead + width > limit) {
      line = []
      lines.push(line)
      used = indent
      lead = 0
    }
    line.push({ ...unit[0], space: lead === 1 }, ...unit.slice(1))
    used += lead + width
  }
  return lines[0].length > 0 ? lines : []
}

/**
 * The reasons of visible errors by group, as `[{ group, whys }]`: one entry per
 * group that has a change, in `GROUPS` order, then `group: null` for `other`
 * and unknown kinds. A reason repeated in a group is listed once.
 */
export const groupReasons = (errors) => {
  const changes = errors.flatMap((e) => e.changes)
  return [...GROUPS, null]
    .map((group) => ({ group, whys: [...new Set(changes.filter((c) => groupOf(c.kind) === group).map((c) => c.why))] }))
    .filter((r) => r.whys.length > 0)
}

const row = (segments) => ({ wrap: 'truncate-end', segments })
const KIND_LABELS = new Map(KINDS.map((k) => [k.slug, k.label]))
const MUTE_HOTKEYS = 'asdfghjkl'
const HINT = 'ctrl+x tab'
const ACTION_INDENT = 2
const ACTION_GAP = 2
const TEXT_INDENT = 2
const REASON_INDENT = 4
const REASON_ROWS = 4

// The distinct muteable kinds of these errors, in order of appearance.
const muteableKinds = (errors) => {
  const slugs = []
  for (const e of errors) for (const c of e.changes) if (KIND_LABELS.has(c.kind) && !slugs.includes(c.kind)) slugs.push(c.kind)
  return slugs.slice(0, MUTE_HOTKEYS.length)
}

/**
 * The action row, `{ actions, hint }`: the toggle `{ key: 'toggle', hotkey: 'm',
 * label: 'more' | 'less' }`, then (expanded only) the mute buttons `{ key, hotkey,
 * label, color }`, then the hint. Too wide: the hint goes first, then the mute
 * buttons from the end; the toggle stays whenever it fits at all (else `null`).
 */
const actionRow = (errors, columns, expanded) => {
  const toggle = { key: 'toggle', hotkey: 'm', label: expanded ? 'less' : 'more' }
  const mutes = expanded
    ? muteableKinds(errors).map((slug, i) => ({
        key: `mute:${slug}`,
        hotkey: MUTE_HOTKEYS[i],
        label: `mute ${KIND_LABELS.get(slug)}`,
        color: groupOf(slug).color,
      }))
    : []
  const width = (acts, hint) =>
    ACTION_INDENT +
    [...acts.map((a) => `${a.hotkey}: ${a.label}`), hint]
      .filter(Boolean)
      .map((t) => t.length)
      .reduce((sum, w, i) => sum + w + (i > 0 ? ACTION_GAP : 0), 0)
  let keep = mutes.length
  while (keep > 0 && width([toggle, ...mutes.slice(0, keep)]) > columns) keep--
  const actions = [toggle, ...mutes.slice(0, keep)]
  if (width(actions) > columns) return null
  return { actions, hint: width(actions, HINT) > columns ? undefined : HINT }
}

// One text line of tokens as segments: a space before a token joins the style
// of the token before it when both are alike, else it is plain; equal styles merge.
const lineSegments = (line, indent) => {
  const segments = []
  const push = (text, style) => {
    const prev = segments[segments.length - 1]
    if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) prev.text += text
    else segments.push({ text, style })
  }
  if (indent > 0) push(' '.repeat(indent), {})
  line.forEach((t, i) => {
    if (i > 0 && t.space) push(' ', JSON.stringify(line[i - 1].style) === JSON.stringify(t.style) ? t.style : {})
    push(t.text, t.style)
  })
  return segments
}

// Whether a line of tokens fits in `columns` with a `…` after it (a continuation line
// starts at REASON_INDENT).
const fitsWithCut = (line, columns, lead) => lead + line.reduce((sum, t) => sum + t.text.length + (t.space ? 1 : 0), 0) + 1 <= columns

// The reasons rows, REASON_ROWS at most. Up to REASON_ROWS groups: each gets its own
// row first; the rows left over go to the groups in order, each taking what it needs to
// wrap (continuation lines indented REASON_INDENT), and a group longer than its rows
// ends in `…`. More groups: the first REASON_ROWS - 1 get one row each (cut with `…`),
// and the rest go together on the last row, each in its own color, for truncate-end to
// cut (built from the groups' own tokens: a wrapped line's first token has no space
// before it).
const reasonRows = (errors, columns) => {
  const groups = groupReasons(errors).map(({ group, whys }) => {
    const style = group ? { color: group.color } : DIM
    const words = `${group ? group.label : 'other'}: ${whys.join(' · ')}`.split(' ')
    const tokens = [{ text: '  ', space: false, style: {} }, ...words.map((text, i) => ({ text, space: i > 0, style }))]
    return { style, tokens, lines: wrapTokens(tokens, columns, REASON_INDENT) }
  })
  const packed = groups.length > REASON_ROWS
  const own = packed ? groups.slice(0, REASON_ROWS - 1) : groups
  let spare = REASON_ROWS - own.length - (packed ? 1 : 0)
  const rows = []
  for (const { style, lines } of own) {
    const extra = Math.min(spare, lines.length - 1)
    spare -= extra
    const shown = lines.slice(0, 1 + extra)
    shown.forEach((line, i) => {
      const lead = i === 0 ? 0 : REASON_INDENT
      if (i < shown.length - 1 || shown.length === lines.length) return rows.push(row(lineSegments(line, lead)))
      const kept = [...line]
      while (kept.length > 1 && (kept.at(-1).text === '·' || !fitsWithCut(kept, columns, lead))) kept.pop()
      rows.push(row(lineSegments([...kept, { text: ELLIPSIS, space: false, style }], lead)))
    })
  }
  if (packed) rows.push(row(lineSegments(groups.slice(REASON_ROWS - 1).flatMap((g) => g.tokens), 0)))
  return rows
}

/**
 * Lays out the band in the look of the built-in you-should-know band: an
 * accent glyph, a dim tag, then the whole draft with every fix applied, the
 * changed words in their group's color, wrapped at `bodyColumns` (continuation
 * lines indented 2). Minimal (the default): then the toggle row alone. `expanded`:
 * then the reasons rows (at most REASON_ROWS: a row per error group in the
 * group's color, `other` dim, wrapped; see `reasonRows`) and the action row, whose
 * first button is the toggle. No toggle row when expanding would add nothing (no
 * reasons rows, no mute buttons). Text and reasons rows are styled segments
 * `{ wrap, segments }`, each meant for `wrap: 'truncate-end'`; the action row is
 * `{ actions: [{ key, hotkey, label, color? }], hint }` (Buttons plus dim text).
 * view: `{ kind: 'ok', source }` | `{ kind: 'fix', source, text, errors }`
 * (`source`: 'draft' | 'sent'). `muted` (kind slugs) is filtered out of the
 * errors; with none left the band reads "no errors". `bodyColumns` is the width
 * of the band (unbounded when left out).
 * Returns `{ gap, rows }`: `gap` asks for one blank row above the rows, and is
 * set only when the gap and every row fit in `maxRows`. A band taller than
 * `maxRows` returns all its rows, for the engine to scroll. `maxRows <= 0`: no rows.
 */
export const bandRows = (view, { maxRows, bodyColumns = Infinity, muted = [], expanded = false }) => {
  if (maxRows <= 0) return { gap: false, rows: [] }
  const tag = { text: view.source === 'sent' ? 'English · sent · ' : 'English · ', style: DIM }
  const errors = view.kind === 'fix' ? visibleErrors(view.errors, muted) : []
  if (errors.length === 0) {
    return { gap: maxRows >= 2, rows: [row([{ text: '✓ ', style: ACCENT }, tag, { text: 'no errors', style: DIM }])] }
  }

  const tokens = [
    { text: '✎ ', space: false, style: ACCENT },
    { ...tag, space: false },
    ...fixedTokens(view.text, view.errors, muted).map((t, i) => (i === 0 ? { ...t, breakBefore: true } : t)),
  ]
  const rows = wrapTokens(tokens, bodyColumns, TEXT_INDENT).map((line, i) => row(lineSegments(line, i === 0 ? 0 : TEXT_INDENT)))
  const reasons = reasonRows(errors, bodyColumns)
  if (reasons.length > 0 || muteableKinds(errors).length > 0) {
    if (expanded) rows.push(...reasons)
    const actions = actionRow(errors, bodyColumns, expanded)
    if (actions !== null) rows.push(actions)
  }
  return { gap: rows.length + 1 <= maxRows, rows }
}
