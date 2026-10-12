import { describe, expect, test } from 'claude-code/testing'
import { KINDS, alignWords, bandRows, diffWords, normalizeWhitespace, parseErrors, prepareDraft, systemPrompt, visibleErrors } from '../hooks/lib.js'

const SENT = 'I want that you checks my text. It is fine here.'
const fix = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    errors: [
      {
        original: 'I want that you checks my text.',
        corrected: 'I want you to check my text.',
        changes: [{ kind: 'verb-form', why: 'want + object · verb form' }],
      },
    ],
    ...extra,
  })

describe('normalizeWhitespace', () => {
  test('collapses runs and trims', async () => {
    expect(normalizeWhitespace('  a \n\t b   c  ')).toBe('a b c')
  })
})

describe('prepareDraft skip rules', () => {
  test('empty and blank drafts are skipped', async () => {
    expect(prepareDraft('')).toBeNull()
    expect(prepareDraft('   \n ')).toBeNull()
  })

  test('3-word boundary', async () => {
    expect(prepareDraft('two words')).toBeNull()
    expect(prepareDraft('three words here')).toBe('three words here')
  })

  test('leading / or ! skips, also after whitespace', async () => {
    expect(prepareDraft('/help me with this please')).toBeNull()
    expect(prepareDraft('  /help me with this please')).toBeNull()
    expect(prepareDraft('!ls -la some more words')).toBeNull()
    expect(prepareDraft('\n !echo hi there friend')).toBeNull()
  })

  test('mostly code or path symbols is skipped', async () => {
    expect(prepareDraft('if (a[0] == b) { x = y; } else { z(); }')).toBeNull()
    expect(prepareDraft('src/{a,b}/[c]/(d)/<e>/*.ts => ~/x/y/z')).toBeNull()
  })

  test('prose with a few symbols is kept', async () => {
    const t = 'Please fix the bug in src/app.ts when the user clicks save'
    expect(prepareDraft(t)).toBe(t)
  })
})

describe('prepareDraft fenced blocks', () => {
  test('fence removed, prose kept', async () => {
    const draft = 'Please look at this:\n```js\nconst a = {b: [1]};\n```\nand tell me why it fail'
    const out = prepareDraft(draft) as string
    expect(out).toContain('Please look at this:')
    expect(out).toContain('and tell me why it fail')
    expect(out).not.toContain('const a')
    expect(out).not.toContain('```')
  })

  test('3-word rule applies to what remains', async () => {
    expect(prepareDraft('Why fails?\n```\nlots of words inside the fence here\n```')).toBeNull()
  })

  test('unterminated fence runs to the end', async () => {
    const out = prepareDraft('Please check this thing\n```js\nconst x = 1 and more words here')
    expect(out).toBe('Please check this thing')
  })
})

describe('prepareDraft length cap', () => {
  test('exactly 4000 chars is sent whole', async () => {
    const exact = 'word '.repeat(799) + 'wwwww'
    expect(exact.length).toBe(4000)
    expect((prepareDraft(exact) as string).length).toBe(4000)
  })

  test('longer than 4000 keeps the trailing part, cut forward to a sentence start', async () => {
    const sentence = 'This is a sentence. '
    const draft = sentence.repeat(300) // 6000 chars
    const out = prepareDraft(draft) as string
    expect(out.length).toBeLessThanOrEqual(4000)
    expect(out.length).toBeGreaterThan(3900)
    expect(out.startsWith('This is a sentence.')).toBe(true)
    expect(draft.trim().endsWith(out)).toBe(true)
  })

  test('the cut lands after the first boundary in the trailing 4000', async () => {
    const draft = 'Head words. '.repeat(10) + 'a'.repeat(3990) + '. Last bit of text here'
    expect(prepareDraft(draft)).toBe('Last bit of text here')
  })
})

describe('prepareDraft after the trailing cut', () => {
  test('a cut tail under 3 words is skipped, not sent', async () => {
    expect(prepareDraft('a'.repeat(4000) + '. Go now')).toBeNull()
  })

  test('a cut tail that is mostly code symbols is skipped', async () => {
    expect(prepareDraft('word '.repeat(1000) + '. {}[]()<>;= {}[]()<>;= {}[]()<>;=')).toBeNull()
  })
})

describe('parseErrors replies and quote matching', () => {
  test('malformed and empty replies give nothing', async () => {
    expect(parseErrors('', SENT)).toBeNull()
    expect(parseErrors('no json here', SENT)).toBeNull()
    expect(parseErrors('{not json}', SENT)).toBeNull()
    expect(parseErrors('[1,2]', SENT)).toBeNull()
    expect(parseErrors('{"foo":1}', SENT)).toBeNull()
  })

  test('truncated JSON gives nothing', async () => {
    expect(parseErrors(fix().slice(0, 60), SENT)).toBeNull()
  })

  test('prose around the JSON: first object is taken', async () => {
    const reply = `Here you go: {"ok":true} and also {"skip":true} thanks`
    expect(parseErrors(reply, SENT)).toBe('ok')
  })

  test('```json fenced reply', async () => {
    expect(parseErrors('```json\n' + fix() + '\n```', SENT)).not.toBeNull()
    expect(parseErrors('```json\n{"ok":true}\n```', SENT)).toBe('ok')
  })

  test('braces inside strings do not end the object early', async () => {
    const reply = JSON.stringify({
      errors: [
        {
          original: 'I want that you checks my text.',
          corrected: 'I want {you} to check my text.',
          changes: [{ kind: 'verb-form', why: 'a } b' }],
        },
      ],
    })
    expect((parseErrors(reply, SENT) as { errors: { changes: { why: string }[] }[] }).errors[0]!.changes[0]!.why).toBe('a } b')
  })

  test('corrected equal to original (after normalization) gives nothing', async () => {
    const reply = JSON.stringify({
      errors: [
        {
          original: 'I want that you checks my text.',
          corrected: 'I  want that you\nchecks my text.',
          changes: [{ kind: 'verb-form', why: 'x' }],
        },
      ],
    })
    expect(parseErrors(reply, SENT)).toBeNull()
  })

  test('original matched after whitespace normalization', async () => {
    const sent = 'I want that   you\nchecks my text. It is fine.'
    expect(parseErrors(fix(), sent)).not.toBeNull()
  })

  test('original not found in the sent text gives nothing', async () => {
    expect(parseErrors(fix(), 'Something else entirely, with no match.')).toBeNull()
  })

  const quote = (original: string) =>
    JSON.stringify({ errors: [{ original, corrected: original + ' fixed', changes: [{ kind: 'other', why: 'x' }] }] })

  test('a fragment inside a longer word is rejected', async () => {
    expect(parseErrors(quote('he is'), 'the is fine here')).toBeNull()
    expect(parseErrors(quote('is fine'), 'this fine here')).toBeNull()
    expect(parseErrors(quote('fine he'), 'fine here')).toBeNull()
  })

  test('a one-word quote is rejected even when it is a whole word', async () => {
    expect(parseErrors(quote('text.'), SENT)).toBeNull()
    expect(parseErrors(quote('text'), SENT)).toBeNull()
  })

  test('a whole-word run of 2 or more words inside the sentence is accepted', async () => {
    expect(parseErrors(quote('want that'), SENT)).not.toBeNull()
    expect(parseErrors(quote('checks my text'), SENT)).not.toBeNull()
  })

  test('a later whole-word occurrence is found after an earlier partial one', async () => {
    expect(parseErrors(quote('he is'), 'the is, he is here')).not.toBeNull()
  })
})

describe('diffWords', () => {
  const changed = (a: string, b: string) => diffWords(a, b).filter((w) => w.changed).map((w) => w.word)
  const words = (a: string, b: string) => diffWords(a, b).map((w) => w.word)

  test('insertion', async () => {
    expect(words('I want check it', 'I want to check it')).toEqual(['I', 'want', 'to', 'check', 'it'])
    expect(changed('I want check it', 'I want to check it')).toEqual(['to'])
  })

  test('replacement', async () => {
    expect(changed('She go home', 'She goes home')).toEqual(['goes'])
  })

  test('deletion marks nothing in the corrected sentence', async () => {
    expect(words('I am am happy', 'I am happy')).toEqual(['I', 'am', 'happy'])
    expect(changed('I am am happy', 'I am happy')).toEqual([])
  })

  test('identical text marks nothing', async () => {
    expect(changed('a b c', 'a b c')).toEqual([])
  })

  test('over 200 words: no highlighting', async () => {
    const a = Array.from({ length: 201 }, (_, i) => `w${i}`).join(' ')
    const b = a.replace('w5', 'changed')
    const out = diffWords(a, b)
    expect(out).toHaveLength(201)
    expect(out.some((w) => w.changed)).toBe(false)
    // 200 words still highlights
    const a2 = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
    expect(changed(a2, a2.replace('w5 ', 'changed '))).toEqual(['changed'])
  })
})

describe('alignWords', () => {
  const split = (s: string) => s.split(' ').filter(Boolean)
  const pairs = [
    ['', ''],
    ['a b', ''],
    ['', 'a b'],
    ['a b c d', 'a b'],
    ['a b', 'a b c d'],
    ['see it I cant', "I can't see it"],
    ['x y', 'p q r'],
    ['I want check it', 'I want to check it'],
    ['She go home', 'She goes home'],
    ['I am am happy', 'I am happy'],
    ['a b c', 'a b c'],
    ['He dont really goes home', "He don't go home"],
    ['She is dont sure of it', "She is not, don't sure of it"],
    ['Why you dont go and stay?', "Why don't you go and don't stay?"],
  ]

  for (const [original, corrected] of pairs) {
    test(`every word of both lists appears once, in order: "${original}" -> "${corrected}"`, async () => {
      const a = split(original)
      const b = split(corrected)
      const ops = alignWords(a, b)
      expect(ops.filter((op) => op.type !== 'ins').map((op) => a[op.i])).toEqual(a)
      expect(ops.filter((op) => op.type !== 'del').map((op) => b[op.j])).toEqual(b)
      expect(ops.filter((op) => op.type !== 'ins').map((op) => op.i)).toEqual(a.map((_, i) => i))
      expect(ops.filter((op) => op.type !== 'del').map((op) => op.j)).toEqual(b.map((_, j) => j))
      for (const op of ops.filter((op) => op.type === 'eq')) expect(a[op.i]).toBe(b[op.j])
    })
  }
})

describe('bandRows', () => {
  type Row = {
    wrap?: string
    segments?: { text: string; style: object }[]
    actions?: { key: string; hotkey: string; label: string }[]
    hint?: string
    pageText?: string
  }
  const err = (n: number, kind = 'article') => ({
    original: `Sentence ${n} here`,
    corrected: `Sentence ${n} there`,
    changes: [{ kind, why: `why ${n}` }],
  })
  const view = (errors: ReturnType<typeof err>[], source: 'draft' | 'sent' = 'draft') => ({ kind: 'fix' as const, source, errors })
  const fixView = {
    kind: 'fix' as const,
    source: 'draft' as const,
    errors: [{ original: 'I want check it', corrected: 'I want to check it', changes: [{ kind: 'article', why: 'missing to' }] }],
  }
  const otherView = view([err(1, 'other')])
  const four = view([err(1, 'apostrophe'), err(2, 'comma'), err(3, 'apostrophe'), err(4, 'spelling')])
  const layout = (v: Parameters<typeof bandRows>[0], opts: Parameters<typeof bandRows>[1]) => bandRows(v, opts) as unknown as { gap: boolean; rows: Row[]; page: number; pages: number }
  const textRows = (rows: Row[]) => rows.filter((r) => r.segments)
  const text = (r: Row) => r.segments!.map((s) => s.text).join('')
  const texts = (rows: Row[]) => textRows(rows).map(text)
  const actionOf = (rows: Row[]) => rows.find((r) => r.actions)
  // The action row as drawn: a 2-space indent, parts 2 spaces apart.
  const drawn = (r: Row) =>
    '  ' + [r.pageText, ...r.actions!.map((a) => `${a.hotkey}: ${a.label}`), r.hint].filter(Boolean).join('  ')

  const ACCENT = { color: 'suggestion' }
  const DIM = { dimColor: true }

  test('fix: one error with a mute button takes three rows, and a gap from four', async () => {
    const at3 = layout(fixView, { maxRows: 3 })
    expect(at3.gap).toBe(false)
    expect(at3.rows).toHaveLength(3)
    expect(texts(at3.rows)).toEqual(['✎ English · I want to check it', '  missing to'])
    expect(textRows(at3.rows)[0]!.segments!.slice(0, 2)).toEqual([
      { text: '✎ ', style: ACCENT },
      { text: 'English · ', style: DIM },
    ])
    expect(textRows(at3.rows)[1]!.segments).toEqual([
      { text: '  ', style: {} },
      { text: 'missing to', style: DIM },
    ])
    expect(actionOf(at3.rows)).toEqual({
      actions: [{ key: 'mute:article', hotkey: 'a', label: 'mute articles' }],
      hint: 'ctrl+x tab',
      pageText: undefined,
    })
    expect(layout(fixView, { maxRows: 4 }).gap).toBe(true)
  })

  test('changed words are styled, others plain', async () => {
    const segs = textRows(layout(fixView, { maxRows: 3 }).rows)[0]!.segments!
    expect(segs).toContainEqual({ text: ' to', style: { color: 'diffAddedWord', bold: true } })
    expect(segs).toContainEqual({ text: 'I want', style: {} })
    expect(segs).toContainEqual({ text: ' check it', style: {} })
  })

  test('4 errors at maxRows 10: 3 errors, the action row and the page text', async () => {
    const { gap, rows, page, pages } = layout(four, { maxRows: 10 })
    expect(gap).toBe(true)
    expect([page, pages]).toEqual([0, 2])
    expect(rows).toHaveLength(7)
    expect(texts(rows)).toEqual([
      '✎ English · Sentence 1 there',
      '  why 1',
      '✎ Sentence 2 there',
      '  why 2',
      '✎ Sentence 3 there',
      '  why 3',
    ])
    expect(rows[6]).toEqual({
      pageText: '‹ 1/2 ›',
      actions: [
        { key: 'page:next', hotkey: 'n', label: 'next' },
        { key: 'page:back', hotkey: 'p', label: 'back' },
        { key: 'mute:apostrophe', hotkey: 'a', label: 'mute apostrophes' },
        { key: 'mute:comma', hotkey: 's', label: 'mute commas' },
      ],
      hint: 'ctrl+x tab',
    })
    expect(drawn(rows[6]!)).toBe('  ‹ 1/2 ›  n: next  p: back  a: mute apostrophes  s: mute commas  ctrl+x tab')
  })

  test('the tag shows on the first error of a page only; page 2 holds the rest', async () => {
    const { rows, page } = layout(four, { maxRows: 10, page: 1 })
    expect(page).toBe(1)
    expect(texts(rows)).toEqual(['✎ English · Sentence 4 there', '  why 4'])
    expect(actionOf(rows)).toEqual({
      pageText: '‹ 2/2 ›',
      actions: [
        { key: 'page:next', hotkey: 'n', label: 'next' },
        { key: 'page:back', hotkey: 'p', label: 'back' },
        { key: 'mute:spelling', hotkey: 'a', label: 'mute spelling' },
      ],
      hint: 'ctrl+x tab',
    })
  })

  test('the page is clamped', async () => {
    expect(layout(four, { maxRows: 10, page: 7 }).page).toBe(1)
    expect(layout(four, { maxRows: 10, page: -2 }).page).toBe(0)
  })

  test('no action row for one page of other kinds; one page with a kind has no page text or n/p', async () => {
    const other = layout(otherView, { maxRows: 10 })
    expect(other.rows).toHaveLength(2)
    expect(actionOf(other.rows)).toBeUndefined()
    const single = actionOf(layout(view([err(1), err(2, 'comma')]), { maxRows: 10 }).rows)!
    expect(single.pageText).toBeUndefined()
    expect(single.actions.map((a) => a.key)).toEqual(['mute:article', 'mute:comma'])
  })

  test('other kinds get no mute button but the page buttons stay', async () => {
    const v = view([err(1, 'other'), err(2, 'other'), err(3, 'other'), err(4, 'other')])
    expect(actionOf(layout(v, { maxRows: 10 }).rows)!.actions.map((a) => a.key)).toEqual(['page:next', 'page:back'])
    const mixed = view([err(1, 'tense-soup'), err(2, 'comma')])
    expect(actionOf(layout(mixed, { maxRows: 10 }).rows)!.actions.map((a) => a.key)).toEqual(['mute:comma'])
  })

  test('at most 9 mute buttons, hotkeys a s d f g h j k l, letters only', async () => {
    const slugs = ['article', 'preposition', 'verb-form', 'agreement', 'word-order', 'word-choice', 'number', 'pronoun', 'apostrophe', 'comma', 'spelling', 'capitalization']
    const many = view([0, 1, 2].map((i) => ({ ...err(i), changes: slugs.slice(i * 4, i * 4 + 4).map((kind) => ({ kind, why: 'x' })) })))
    const wide = actionOf(layout(many, { maxRows: 10 }).rows)!
    expect(wide.actions.map((a) => a.hotkey).join('')).toBe('asdfghjkl')
    expect(wide.actions).toHaveLength(9)
    const hotkeys = [four, view([err(1), err(2, 'comma')]), fixView]
      .flatMap((x) => [3, 5, 7, 10].flatMap((maxRows) => layout(x, { maxRows }).rows))
      .flatMap((r) => r.actions?.map((a) => a.hotkey) ?? [])
    expect(hotkeys.length).toBeGreaterThan(0)
    for (const h of [...hotkeys, ...wide.actions.map((a) => a.hotkey)]) expect(h).toMatch(/^[a-z]$/)
  })

  test('the budget drops the gap, then the page size from 3 to 1', async () => {
    const at = (maxRows: number) => {
      const l = layout(four, { maxRows })
      return [l.gap, textRows(l.rows).length / 2, l.pages]
    }
    expect(at(8)).toEqual([true, 3, 2])
    expect(at(7)).toEqual([false, 3, 2])
    expect(at(6)).toEqual([false, 2, 2])
    expect(at(5)).toEqual([false, 2, 2])
    expect(at(4)).toEqual([false, 1, 4])
    expect(at(3)).toEqual([false, 1, 4])
  })

  test('maxRows 2 and 1 keep the compact forms with no action row', async () => {
    const two = layout(four, { maxRows: 2 })
    expect(two.gap).toBe(false)
    expect(texts(two.rows)).toEqual(['✎ English · Sentence 1 there  +3 more', '  why 1'])
    expect(two.rows.some((r) => r.actions)).toBe(false)
    const one = layout(four, { maxRows: 1 })
    expect(one.gap).toBe(false)
    expect(texts(one.rows)).toEqual(['✎ English · Sentence 1 there  +3 more · why 1'])
    expect(textRows(two.rows)[0]!.segments!.at(-1)).toEqual({ text: '  +3 more', style: DIM })
    expect(texts(layout(fixView, { maxRows: 1 }).rows)).toEqual(['✎ English · I want to check it · missing to'])
  })

  test('a muted kind is drawn out; the compact count follows the visible errors', async () => {
    const l = layout(four, { maxRows: 10, muted: ['apostrophe'] })
    expect(texts(l.rows)).toEqual(['✎ English · Sentence 2 there', '  why 2', '✎ Sentence 4 there', '  why 4'])
    expect(actionOf(l.rows)!.actions.map((a) => a.key)).toEqual(['mute:comma', 'mute:spelling'])
    expect(actionOf(l.rows)!.pageText).toBeUndefined()
    expect(texts(layout(four, { maxRows: 2, muted: ['apostrophe'] }).rows)[0]).toBe('✎ English · Sentence 2 there  +1 more')
  })

  test('muted apostrophes: an apostrophe-only edit labelled spelling draws no highlight', async () => {
    const v = view([
      { original: 'i dont know thing', corrected: "i don't know the thing", changes: [{ kind: 'spelling', why: 'a' }, { kind: 'article', why: 'b' }] },
      { original: 'Its fine', corrected: "It's fine", changes: [{ kind: 'word-choice', why: 'c' }] },
    ])
    const l = layout(v, { maxRows: 10, muted: ['apostrophe'] })
    expect(texts(l.rows)).toEqual(['✎ English · i dont know the thing', '  a · b'])
    const marked = textRows(l.rows)[0]!.segments!.filter((s) => (s.style as { bold?: boolean }).bold).map((s) => s.text)
    expect(marked).toEqual([' the'])
    expect(texts(layout(v, { maxRows: 10 }).rows)).toHaveLength(4)
  })

  test('a muted other is never filtered', async () => {
    expect(texts(layout(otherView, { maxRows: 5, muted: ['article', 'comma'] }).rows)).toHaveLength(2)
  })

  test('all errors muted reads "no errors"', async () => {
    const l = layout(four, { maxRows: 10, muted: ['apostrophe', 'comma', 'spelling'] })
    expect(l.gap).toBe(true)
    expect(texts(l.rows)).toEqual(['✓ English · no errors'])
    expect(l.pages).toBe(1)
    expect(texts(layout(view(four.errors, 'sent'), { maxRows: 1, muted: ['apostrophe', 'comma', 'spelling'] }).rows)).toEqual(['✓ English · sent · no errors'])
  })

  test('a narrow action row drops the hint, then mute buttons from the end', async () => {
    const full = actionOf(layout(four, { maxRows: 10 }).rows)!
    const width = (r: Row) => drawn(r).length
    const at = (bodyColumns: number) => actionOf(layout(four, { maxRows: 10, bodyColumns }).rows)!
    expect(at(width(full)).hint).toBe('ctrl+x tab')
    const noHint = at(width(full) - 1)
    expect(noHint.hint).toBeUndefined()
    expect(noHint.actions.map((a) => a.key)).toEqual(['page:next', 'page:back', 'mute:apostrophe', 'mute:comma'])
    const oneMute = at(width(noHint) - 1)
    expect(oneMute.actions.map((a) => a.key)).toEqual(['page:next', 'page:back', 'mute:apostrophe'])
    const navOnly = at(width(oneMute) - 1)
    expect(navOnly.actions.map((a) => a.key)).toEqual(['page:next', 'page:back'])
    expect(drawn(navOnly)).toBe('  ‹ 1/2 ›  n: next  p: back')
  })

  test('when the page text with n/p does not fit, the compact form is used', async () => {
    const tooNarrow = '  ‹ 1/2 ›  n: next  p: back'.length - 1
    const l = layout(four, { maxRows: 10, bodyColumns: tooNarrow })
    expect(texts(l.rows)).toEqual(['✎ English · Sentence 1 there  +3 more', '  why 1'])
    expect(l.rows.some((r) => r.actions)).toBe(false)
    expect(l.gap).toBe(true)
    // One page and no room for even one mute button: compact too.
    expect(layout(fixView, { maxRows: 10, bodyColumns: 10 }).rows.some((r) => r.actions)).toBe(false)
  })

  test('sent tag only for source sent', async () => {
    expect(text(textRows(layout(fixView, { maxRows: 3 }).rows)[0]!)).not.toContain('sent ·')
    const { rows } = layout({ ...fixView, source: 'sent' }, { maxRows: 3 })
    expect(text(textRows(rows)[0]!)).toBe('✎ English · sent · I want to check it')
    expect(textRows(rows)[0]!.segments![1]).toEqual({ text: 'English · sent · ', style: DIM })
  })

  test('the reasons row joins the changes of an error', async () => {
    const v = view([{ ...err(1), changes: [{ kind: 'article', why: 'missing to' }, { kind: 'spelling', why: 'typo' }] }])
    expect(texts(layout(v, { maxRows: 5 }).rows)[1]).toBe('  missing to · typo')
    expect(texts(layout(v, { maxRows: 5, muted: ['spelling'] }).rows)[1]).toBe('  missing to')
  })

  test('ok rows', async () => {
    const draft = layout({ kind: 'ok', source: 'draft' }, { maxRows: 2 })
    expect(draft.gap).toBe(true)
    expect(draft.rows).toHaveLength(1)
    expect(draft.rows[0]!.segments).toEqual([
      { text: '✓ ', style: ACCENT },
      { text: 'English · ', style: DIM },
      { text: 'no errors', style: DIM },
    ])
    expect(text(draft.rows[0]!)).toBe('✓ English · no errors')
    const sent = layout({ kind: 'ok', source: 'sent' }, { maxRows: 1 })
    expect(sent.gap).toBe(false)
    expect(sent.rows).toHaveLength(1)
    expect(text(sent.rows[0]!)).toBe('✓ English · sent · no errors')
  })

  test('gap by maxRows', async () => {
    const ok = { kind: 'ok' as const, source: 'draft' as const }
    expect([0, 1, 2, 3, 4].map((maxRows) => layout(fixView, { maxRows }).gap)).toEqual([false, false, false, false, true])
    expect([0, 1, 2, 3].map((maxRows) => layout(ok, { maxRows }).gap)).toEqual([false, false, true, true])
    expect(layout(fixView, { maxRows: 0 }).rows).toEqual([])
    expect(layout(ok, { maxRows: 0 }).rows).toEqual([])
  })

  const allViews = [
    fixView,
    otherView,
    four,
    { ...four, source: 'sent' as const },
    view([err(1), err(2, 'comma')]),
    view(Array.from({ length: 8 }, (_, i) => err(i, i % 2 ? 'other' : 'comma'))),
    { kind: 'ok' as const, source: 'draft' as const },
    { kind: 'ok' as const, source: 'sent' as const },
  ]

  test('rows plus gap never exceed maxRows, the action row included', async () => {
    for (const v of allViews) {
      for (const maxRows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        for (const opts of [{}, { muted: ['comma'] }, { page: 1 }, { page: 9, bodyColumns: 30 }, { bodyColumns: 12 }]) {
          const { gap, rows } = layout(v, { maxRows, ...opts })
          expect(rows.length + (gap ? 1 : 0)).toBeLessThanOrEqual(maxRows)
        }
      }
    }
  })

  test('every text row is truncate-end', async () => {
    for (const v of allViews) {
      for (const maxRows of [1, 2, 3, 6, 10]) {
        for (const r of textRows(layout(v, { maxRows }).rows)) expect(r.wrap).toBe('truncate-end')
      }
    }
  })
})

const TEXT = 'I dont know where is the file. She go home. It is fine here.'
const change = (kind: string, why = 'because') => ({ kind, why })
const err = (original: string, corrected: string, changes: unknown = [change('verb-form')]) => ({ original, corrected, changes })
const reply = (errors: unknown) => JSON.stringify({ errors })

describe('parseErrors', () => {
  test('keeps several errors in reply order', async () => {
    const out = parseErrors(
      reply([
        err('I dont know where is the file.', "I don't know where the file is.", [change('apostrophe', 'missing apostrophe'), change('word-order', 'word order')]),
        err('She go home.', 'She goes home.', [change('agreement')]),
      ]),
      TEXT,
    )
    expect(out).toEqual({
      errors: [
        {
          original: 'I dont know where is the file.',
          corrected: "I don't know where the file is.",
          changes: [
            { kind: 'apostrophe', why: 'missing apostrophe' },
            { kind: 'word-order', why: 'word order' },
          ],
        },
        { original: 'She go home.', corrected: 'She goes home.', changes: [{ kind: 'agreement', why: 'because' }] },
      ],
    })
  })

  test('drops one bad error and keeps the rest', async () => {
    const out = parseErrors(
      reply([
        err('Not in the text at all.', 'Fixed.'),
        err('She go home.', 'She go home.'),
        err('She go home.', 'She goes home.', []),
        err('She go home.', 'She goes home.', [{ kind: 'agreement' }]),
        err('I dont know where is the file.', "I don't know where the file is."),
      ]),
      TEXT,
    )
    expect(out).toEqual({
      errors: [{ original: 'I dont know where is the file.', corrected: "I don't know where the file is.", changes: [change('verb-form')] }],
    })
  })

  test('ok, skip and an empty list', async () => {
    expect(parseErrors('{"ok":true}', TEXT)).toBe('ok')
    expect(parseErrors('{"skip":true}', TEXT)).toBe('skip')
    expect(parseErrors('{"errors":[]}', TEXT)).toBe('ok')
  })

  test('errors missing or not an array gives null', async () => {
    expect(parseErrors('{}', TEXT)).toBeNull()
    expect(parseErrors('{"errors":"none"}', TEXT)).toBeNull()
    expect(parseErrors('{"errors":{"original":"x"}}', TEXT)).toBeNull()
    expect(parseErrors('not json', TEXT)).toBeNull()
  })

  test('errors present but none valid gives null', async () => {
    expect(parseErrors(reply([err('Not in the text at all.', 'Fixed.'), 'junk', null]), TEXT)).toBeNull()
  })

  test('keeps at most 8 errors', async () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Word${i} goes here.`)
    const out = parseErrors(reply(sentences.map((s) => err(s, s.replace('goes', 'go')))), sentences.join(' '))
    expect(out).not.toBeNull()
    expect(out).not.toBe('ok')
    const { errors } = out as { errors: { original: string }[] }
    expect(errors.map((e) => e.original)).toEqual(sentences.slice(0, 8))
  })

  test('keeps at most 6 changes per error', async () => {
    const changes = Array.from({ length: 9 }, (_, i) => change('spelling', `fix ${i}`))
    const out = parseErrors(reply([err('She go home.', 'She goes home.', changes)]), TEXT) as { errors: { changes: unknown[] }[] }
    expect(out.errors[0].changes).toEqual(changes.slice(0, 6))
  })

  test('an unknown or missing kind becomes other', async () => {
    const out = parseErrors(
      reply([err('She go home.', 'She goes home.', [{ kind: 'tense-soup', why: 'a' }, { why: 'b' }, { kind: 7, why: 'c' }, change('comma', 'd')])]),
      TEXT,
    ) as { errors: { changes: unknown[] }[] }
    expect(out.errors[0].changes).toEqual([
      { kind: 'other', why: 'a' },
      { kind: 'other', why: 'b' },
      { kind: 'other', why: 'c' },
      { kind: 'comma', why: 'd' },
    ])
  })

  test('a repeated original keeps the first error', async () => {
    const out = parseErrors(
      reply([err('She go home.', 'She goes home.'), err('She  go\nhome.', 'She is going home.', [change('other', 'x')])]),
      TEXT,
    )
    expect(out).toEqual({ errors: [{ original: 'She go home.', corrected: 'She goes home.', changes: [change('verb-form')] }] })
  })

  test('a change without a string why is dropped; an error left empty goes with it', async () => {
    const out = parseErrors(
      reply([
        err('She go home.', 'She goes home.', [{ kind: 'agreement' }, { kind: 'agreement', why: 4 }, change('number', 'kept')]),
        err('I dont know where is the file.', 'x', [{ kind: 'apostrophe' }]),
      ]),
      TEXT,
    )
    expect(out).toEqual({ errors: [{ original: 'She go home.', corrected: 'She goes home.', changes: [change('number', 'kept')] }] })
  })

  test('normalizes whitespace and needs a word run in the sent text', async () => {
    expect(parseErrors(reply([err('She   go\nhome.', 'She  goes  home.')]), TEXT)).toEqual({
      errors: [{ original: 'She go home.', corrected: 'She goes home.', changes: [change('verb-form')] }],
    })
    expect(parseErrors(reply([err('She go', 'She goes')]), 'She goes to the shop.')).toBeNull()
    expect(parseErrors(reply([err('go', 'goes')]), TEXT)).toBeNull()
  })

  test('finds the object inside a fence or prose', async () => {
    const body = reply([err('She go home.', 'She goes home.')])
    expect(parseErrors('```json\n' + body + '\n```', TEXT)).not.toBeNull()
    expect(parseErrors('Here: ' + body + ' done', TEXT)).not.toBeNull()
  })
})

describe('visibleErrors', () => {
  const mixed = {
    original: 'I dont know where is the file.',
    corrected: "I don't know where the file is.",
    changes: [change('apostrophe'), change('word-order')],
  }
  const apostropheOnly = { original: 'Its fine here.', corrected: "It's fine here.", changes: [change('apostrophe')] }

  test('a mixed error keeps only the changes that are not muted', async () => {
    expect(visibleErrors([mixed], ['apostrophe'])).toEqual([
      { ...mixed, corrected: 'I dont know where the file is.', changes: [change('word-order')] },
    ])
    expect(visibleErrors([mixed], ['spelling'])).toEqual([mixed])
  })

  test('an error with every change muted is dropped; all muted gives an empty list', async () => {
    expect(visibleErrors([mixed, apostropheOnly], ['apostrophe'])).toHaveLength(1)
    expect(visibleErrors([mixed, apostropheOnly], ['apostrophe', 'word-order'])).toEqual([])
  })

  test('nothing muted keeps everything; other is never filtered by a muted kind', async () => {
    const other = { original: 'She go home.', corrected: 'She goes home.', changes: [change('other')] }
    expect(visibleErrors([mixed, other], [])).toEqual([mixed, other])
    expect(visibleErrors([other], ['apostrophe'])).toEqual([other])
  })

  test('does not change its input', async () => {
    visibleErrors([mixed], ['apostrophe'])
    expect(mixed.changes).toHaveLength(2)
    expect(mixed.corrected).toBe("I don't know where the file is.")
  })

  describe('apostrophes muted: the word diff reverts apostrophe-only edits', () => {
    const e = (original: string, corrected: string, kind = 'spelling') => ({ original, corrected, changes: [change(kind)] })
    const muted = ['apostrophe']

    test('an apostrophe-only edit is dropped whatever its label says', async () => {
      expect(visibleErrors([e('i dont know', "i don't know")], muted)).toEqual([])
      expect(visibleErrors([e('Its fine here.', "It's fine here.", 'word-choice')], muted)).toEqual([])
      expect(visibleErrors([e('im sure', "I'm sure")], muted)).toEqual([])
      expect(visibleErrors([e('I cant go', "I can’t go")], muted)).toEqual([])
      expect(visibleErrors([e("the users files", "the users' files")], muted)).toEqual([])
    })

    test('a mixed error is kept: the other fix stays, the apostrophe is left unfixed', async () => {
      const mixedErr = { original: 'i dont know thing', corrected: "i don't know the thing", changes: [change('spelling'), change('article')] }
      expect(visibleErrors([mixedErr], muted)).toEqual([{ ...mixedErr, corrected: 'i dont know the thing' }])
    })

    test('a case fix is not an apostrophe edit', async () => {
      const caseFix = e('i know', 'I know')
      expect(visibleErrors([caseFix], muted)).toEqual([caseFix])
    })

    test('an apostrophe fix next to a word replacement pairs by position', async () => {
      const both = e('She dont goes home', "She don't go home")
      expect(visibleErrors([both], muted)).toEqual([{ ...both, corrected: 'She dont go home' }])
    })

    test('an apostrophe fix is reverted wherever it sits in a replaced run', async () => {
      const inserted = e('I hope dont fail', "I hope I don't fail")
      expect(visibleErrors([inserted], muted)).toEqual([{ ...inserted, corrected: 'I hope I dont fail' }])
      const deleted = e('He dont really goes home', "He don't go home")
      expect(visibleErrors([deleted], muted)).toEqual([{ ...deleted, corrected: 'He dont go home' }])
      const reordered = e('She is dont sure of it', "She is not, don't sure of it")
      expect(visibleErrors([reordered], muted)).toEqual([{ ...reordered, corrected: 'She is not, dont sure of it' }])
    })

    test('an apostrophe fix is reverted when the word moved outside its replaced run', async () => {
      const moved = e('Why you dont go?', "Why don't you go?", 'word-order')
      expect(visibleErrors([moved], muted)).toEqual([{ ...moved, corrected: 'Why dont you go?' }])
      const reasoned = { ...moved, changes: [change('word-order', 'Use question order'), change('spelling', "Write don't")] }
      expect(visibleErrors([reasoned], muted)[0].changes).toEqual([change('word-order', 'Use question order')])
      expect(visibleErrors([moved], [])).toEqual([moved])
    })

    test('an apostrophe fix is reverted when the word moved from the end', async () => {
      const fromEnd = e('see it I cant', "I can't see it", 'word-order')
      expect(visibleErrors([fromEnd], muted)).toEqual([{ ...fromEnd, corrected: 'I cant see it' }])
    })

    test('each deleted and inserted word is matched at most once across the error', async () => {
      const twice = e('Why you dont go and dont stay?', "Why don't you go and don't stay?", 'word-order')
      expect(visibleErrors([twice], muted)).toEqual([{ ...twice, corrected: 'Why dont you go and dont stay?' }])
      const once = e('Why you dont go and stay?', "Why don't you go and don't stay?", 'word-order')
      expect(visibleErrors([once], muted)[0].corrected).toBe("Why dont you go and don't stay?")
    })

    test('reasons and mute buttons do not describe a reverted apostrophe edit', async () => {
      const mixedErr = {
        original: 'i dont know thing',
        corrected: "i don't know the thing",
        changes: [change('spelling', 'Use apostrophe in contraction'), change('article', 'Add the before thing')],
      }
      expect(visibleErrors([mixedErr], muted)).toEqual([
        { ...mixedErr, corrected: 'i dont know the thing', changes: [change('article', 'Add the before thing')] },
      ])
      const byWord = { ...mixedErr, changes: [change('spelling', 'dont is a typo'), change('article', 'Add the')] }
      expect(visibleErrors([byWord], muted)[0].changes).toEqual([change('article', 'Add the')])
      const byForm = { ...mixedErr, changes: [change('spelling', "Write Don't"), change('article', 'Add the')] }
      expect(visibleErrors([byForm], muted)[0].changes).toEqual([change('article', 'Add the')])
      const rows = bandRows({ kind: 'fix', source: 'draft', errors: [mixedErr] }, { maxRows: 6, muted })
      expect(JSON.stringify(rows)).not.toContain('mute spelling')
      expect(JSON.stringify(rows)).not.toContain('apostrophe')
    })

    test('an error whose changes are all reverted reasons stays with an empty list while corrected differs', async () => {
      const onlyLabelled = {
        original: 'i dont know thing',
        corrected: "i don't know the thing",
        changes: [change('spelling', 'Use apostrophe in contraction')],
      }
      expect(visibleErrors([onlyLabelled], muted)).toEqual([{ ...onlyLabelled, corrected: 'i dont know the thing', changes: [] }])
    })

    test('a reason is kept when no apostrophe edit was reverted', async () => {
      const plain = { original: 'She go home', corrected: 'She goes home', changes: [change('spelling', 'apostrophe-like typo')] }
      expect(visibleErrors([plain], muted)).toEqual([plain])
    })

    test('over 200 words: no revert', async () => {
      const long = Array.from({ length: 201 }, (_, i) => `w${i}`).join(' ')
      const err201 = e(`dont ${long}`, `don't ${long}`)
      expect(visibleErrors([err201], muted)).toEqual([err201])
      const long2 = Array.from({ length: 199 }, (_, i) => `w${i}`).join(' ')
      expect(visibleErrors([e(`dont ${long2}`, `don't ${long2}`)], muted)).toEqual([])
    })

    test('apostrophe not muted: the output is the label filter alone', async () => {
      const a = e('i dont know', "i don't know")
      expect(visibleErrors([a], [])).toEqual([a])
      expect(visibleErrors([a], ['comma'])).toEqual([a])
    })
  })
})

describe('systemPrompt', () => {
  test('names the reply shapes, kinds and carried-over rules', async () => {
    const prompt = systemPrompt([])
    for (const s of ['{"ok":true}', '{"skip":true}', '"errors"', '"changes"', '"kind"', '"why"', '40 words', 'not English', 'in the order', 'at most 8']) {
      expect(prompt).toContain(s)
    }
    for (const { slug } of KINDS) expect(prompt).toContain(slug)
    expect(prompt).toContain('other')
    expect(prompt).toContain('grammar')
    expect(prompt).toContain('spelling')
    expect(prompt).toContain('Ignore:')
  })

  test('tells the model to skip shell commands', async () => {
    const prompt = systemPrompt([])
    expect(prompt).toContain('shell command')
    expect(prompt).toMatch(/shell command[^\n]*\{"skip":true\}/)
    expect(prompt).toContain('git commit -m')
  })

  test('has no muted line by default', async () => {
    expect(systemPrompt([])).not.toContain('Do not report')
    expect(systemPrompt()).not.toContain('Do not report')
  })

  test('muted kinds add one line with their labels', async () => {
    const prompt = systemPrompt(['apostrophe', 'verb-form'])
    expect(prompt).toContain('Do not report or fix these kinds: verb forms, apostrophes.')
    expect(prompt.match(/Do not report/g)).toHaveLength(1)
  })

  test('an unknown muted slug adds no line', async () => {
    expect(systemPrompt(['nope'])).not.toContain('Do not report')
  })
})
