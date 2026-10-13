import { describe, expect, test } from 'claude-code/testing'
import { GROUPS, KINDS, alignWords, bandRows, diffWords, fixedTokens, groupOf, groupReasons, normalizeWhitespace, parseErrors, prepareDraft, systemPrompt, visibleErrors, wrapTokens } from '../hooks/lib.js'

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
    actions?: { key: string; hotkey: string; label: string; color: string }[]
    hint?: string
  }
  const err = (n: number, kind = 'article') => ({
    original: `Sentence ${n} here`,
    corrected: `Sentence ${n} there`,
    changes: [{ kind, why: `why ${n}` }],
  })
  const view = (errors: ReturnType<typeof err>[], source: 'draft' | 'sent' = 'draft') => ({
    kind: 'fix' as const,
    source,
    text: errors.map((e) => e.original).join(' '),
    errors,
  })
  const fixView = {
    kind: 'fix' as const,
    source: 'draft' as const,
    text: 'I want check it',
    errors: [{ original: 'I want check it', corrected: 'I want to check it', changes: [{ kind: 'article', why: 'missing to' }] }],
  }
  const otherView = view([err(1, 'other')])
  const four = view([err(1, 'apostrophe'), err(2, 'comma'), err(3, 'apostrophe'), err(4, 'spelling')])
  // Four groups and `other`: spelling, grammar, other, punctuation.
  const grouped = view([err(1, 'spelling'), err(2, 'verb-form'), err(3, 'other'), err(4, 'comma')])
  // Expanded unless a test says otherwise: most tests look at the reasons rows and the mute buttons.
  const layout = (v: Parameters<typeof bandRows>[0], opts: Parameters<typeof bandRows>[1]) => bandRows(v, { expanded: true, ...opts }) as unknown as { gap: boolean; rows: Row[] }
  const textRows = (rows: Row[]) => rows.filter((r) => r.segments)
  const text = (r: Row) => r.segments!.map((s) => s.text).join('')
  const texts = (rows: Row[]) => textRows(rows).map(text)
  const actionOf = (rows: Row[]) => rows.find((r) => r.actions)
  const TOGGLE = { key: 'toggle', hotkey: 'm' }
  const mutesOf = (r: Row) => r.actions!.filter((a) => a.key !== 'toggle')
  // The action row as drawn: a 2-space indent, parts 2 spaces apart.
  const drawn = (r: Row) => '  ' + [...r.actions!.map((a) => `${a.hotkey}: ${a.label}`), r.hint].filter(Boolean).join('  ')

  const ACCENT = { color: 'suggestion' }
  const DIM = { dimColor: true }

  test('fix: the text row, a reasons row and the action row take three rows, and a gap from four', async () => {
    const at3 = layout(fixView, { maxRows: 3 })
    expect(at3.gap).toBe(false)
    expect(at3.rows).toHaveLength(3)
    expect(texts(at3.rows)).toEqual(['✎ English · I want to check it', '  small words: missing to'])
    expect(textRows(at3.rows)[0]!.segments!.slice(0, 2)).toEqual([
      { text: '✎ ', style: ACCENT },
      { text: 'English · ', style: DIM },
    ])
    expect(textRows(at3.rows)[1]!.segments).toEqual([
      { text: '  ', style: {} },
      { text: 'small words: missing to', style: { color: 'ide' } },
    ])
    expect(actionOf(at3.rows)).toEqual({
      actions: [
        { ...TOGGLE, label: 'less' },
        { key: 'mute:article', hotkey: 'a', label: 'mute articles', color: 'ide' },
      ],
      hint: 'ctrl+x tab',
    })
    expect(layout(fixView, { maxRows: 4 }).gap).toBe(true)
  })

  test('changed words are in their group color and bold, others plain', async () => {
    const segs = textRows(layout(fixView, { maxRows: 3 }).rows)[0]!.segments!
    expect(segs).toContainEqual({ text: 'to', style: { color: 'ide', bold: true } })
    expect(segs).toContainEqual({ text: 'I want ', style: {} })
    expect(segs).toContainEqual({ text: ' check it', style: {} })
  })

  test('all errors are one text: every fix applied, in order', async () => {
    const l = layout(four, { maxRows: 10 })
    expect(texts(l.rows)[0]).toBe('✎ English · Sentence 1 there Sentence 2 there Sentence 3 there Sentence 4 there')
  })

  test('the text wraps at bodyColumns: the tag on line 1 only, continuation lines indented 2', async () => {
    const l = layout(fixView, { maxRows: 10, bodyColumns: 24 })
    expect(texts(l.rows).slice(0, 2)).toEqual(['✎ English · I want to', '  check it'])
    expect(textRows(l.rows)[1]!.segments![0]).toEqual({ text: '  check it', style: {} })
    const wide = layout(fixView, { maxRows: 10, bodyColumns: 30 })
    expect(texts(wide.rows)[0]).toBe('✎ English · I want to check it')
    const lines = texts(layout(four, { maxRows: 10, bodyColumns: 30 }).rows).slice(0, 3)
    expect(lines).toEqual(['✎ English · Sentence 1 there', '  Sentence 2 there Sentence 3', '  there Sentence 4 there'])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30)
  })

  test('a long first word wraps to its own line after the tag instead of being cut', async () => {
    const v = {
      kind: 'fix' as const,
      source: 'draft' as const,
      text: 'Internationalisation is hard',
      errors: [{ original: 'hard', corrected: 'difficult', changes: [{ kind: 'word-choice', why: 'clearer' }] }],
    }
    const l = layout(v, { maxRows: 10, bodyColumns: 30 })
    expect(texts(l.rows).slice(0, 3)).toEqual(['✎ English · ', '  Internationalisation is', '  difficult'])
    expect(layout(v, { maxRows: 10, bodyColumns: 40 }).rows.map((r) => r.segments && text(r))[0]).toBe('✎ English · Internationalisation is')
  })

  test('one reasons row per group in group order, then other, each in its color', async () => {
    const { rows } = layout(grouped, { maxRows: 10 })
    expect(texts(rows)).toEqual([
      '✎ English · Sentence 1 there Sentence 2 there Sentence 3 there Sentence 4 there',
      '  grammar: why 2',
      '  spelling: why 1',
      '  punctuation: why 4',
      '  other: why 3',
    ])
    expect(textRows(rows).slice(1).map((r) => r.segments![1]!.style)).toEqual([
      { color: 'warning' },
      { color: 'success' },
      { color: 'claude' },
      DIM,
    ])
  })

  describe('reasons rows', () => {
    const multi = (...changes: [string, string][]) => ({
      kind: 'fix' as const,
      source: 'draft' as const,
      text: 'Hi',
      errors: [{ original: 'Hi', corrected: 'Yo', changes: changes.map(([kind, why]) => ({ kind, why })) }],
    })
    const reasons = (v: Parameters<typeof bandRows>[0], bodyColumns: number) => layout(v, { maxRows: 99, bodyColumns }).rows.filter((r) => r.segments).slice(1)
    const long = 'Base form after "to" · "before" clause needs simple present · Past tense needed with "Yesterday"'
    const example = multi(
      ['verb-form', 'Base form after "to"'],
      ['verb-form', '"before" clause needs simple present'],
      ['verb-form', 'Past tense needed with "Yesterday"'],
      ['article', 'No article before London'],
      ['article', 'Singular noun needs an article'],
      ['word-choice', '"want" takes an infinitive with "to"'],
      ['comma', 'Contraction needs an apostrophe'],
      ['other', 'odd'],
    )

    test('a long group wraps at the width with a 4-space continuation, in its color', async () => {
      const rows = reasons(multi(['verb-form', long.split(' · ')[0]!], ['verb-form', long.split(' · ')[1]!], ['verb-form', long.split(' · ')[2]!]), 60)
      expect(rows.map(text)).toEqual([
        '  grammar: Base form after "to" · "before" clause needs',
        '    simple present · Past tense needed with "Yesterday"',
      ])
      for (const r of rows) expect(r.segments!.filter((x) => x.text.trim()).every((x) => x.style.color === 'warning')).toBe(true)
      expect(rows[1]!.segments![0]).toEqual({ text: '    ', style: {} })
    })

    test('with more than 4 groups, groups 1-3 get one row each (cut with …) and row 4 packs the rest in their own colors', async () => {
      const rows = reasons(example, 75)
      expect(rows.map(text)).toEqual([
        '  grammar: Base form after "to" · "before" clause needs simple present…',
        '  small words: No article before London · Singular noun needs an article',
        '  wording: "want" takes an infinitive with "to"',
        '  punctuation: Contraction needs an apostrophe  other: odd',
      ])
      expect(rows[3]!.wrap).toBe('truncate-end')
      expect(rows[3]!.segments!.filter((x) => x.text.trim()).map((x) => x.style)).toEqual([{ color: 'claude' }, DIM])
    })

    test('a long second group of five does not move the packed row up: it is always row 4', async () => {
      const v = multi(['verb-form', 'a'], ['article', long], ['word-choice', 'c'], ['comma', 'd'], ['other', 'e'])
      const rows = reasons(v, 55)
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => text(r).split(':')[0])).toEqual(['  grammar', '  small words', '  wording', '  punctuation'])
      expect(text(rows[1]!).endsWith('…')).toBe(true)
      expect(text(rows[3]!)).toBe('  punctuation: d  other: e')
    })

    test('with 5 groups and a long first group, groups 2 and 3 are still visible', async () => {
      const v = multi(['verb-form', long], ['article', 'No article'], ['word-choice', 'want + to'], ['comma', 'apostrophe'], ['other', 'odd'])
      const rows = reasons(v, 55)
      expect(rows.map(text)).toEqual([
        '  grammar: Base form after "to" · "before" clause…',
        '  small words: No article',
        '  wording: want + to',
        '  punctuation: apostrophe  other: odd',
      ])
    })

    test('with 3 groups and a long first group, every group has its row and the spare row wraps the first', async () => {
      const v = multi(['verb-form', long], ['verb-form', 'A fourth reason that runs on'], ['article', 'No article'], ['word-choice', 'want + to'])
      const rows = reasons(v, 55)
      expect(rows.map(text)).toEqual([
        '  grammar: Base form after "to" · "before" clause needs',
        '    simple present · Past tense needed with…',
        '  small words: No article',
        '  wording: want + to',
      ])
      expect(rows[1]!.segments![0]).toEqual({ text: '    ', style: {} })
    })

    test('with up to 4 groups, every group is visible in its own row whatever the width', async () => {
      const four = multi(['verb-form', long], ['article', long], ['word-choice', long], ['comma', long])
      for (const w of [20, 30, 55, 120]) {
        expect(reasons(four, w).map((r) => text(r).trim().split(':')[0])).toEqual(['grammar', 'small words', 'wording', 'punctuation'])
      }
      const two = multi(['verb-form', long], ['article', long])
      const rows = reasons(two, 40)
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => text(r).trim().split(':')[0]).filter((t) => t === 'grammar' || t === 'small words')).toEqual(['grammar', 'small words'])
    })

    test('spare rows go to long groups in order: the first takes what it needs, the next what is left', async () => {
      const two = multi(['verb-form', long], ['article', long])
      const rows = reasons(two, 60)
      // 'grammar' wraps to 2 lines, 'small words' to 2: both fit in 4 rows.
      expect(rows.map(text)).toEqual([
        '  grammar: Base form after "to" · "before" clause needs',
        '    simple present · Past tense needed with "Yesterday"',
        '  small words: Base form after "to" · "before" clause needs',
        '    simple present · Past tense needed with "Yesterday"',
      ])
    })

    test('a group that wrapped keeps its single spaces when it is packed onto the last row', async () => {
      const v = multi(
        ['verb-form', 'a'],
        ['article', 'b'],
        ['word-choice', 'c'],
        ['spelling', '"want" takes an infinitive with "to" and a few more words here and there ok'],
        ['comma', 'Contraction needs an apostrophe'],
        ['other', 'odd'],
      )
      const rows = reasons(v, 40)
      expect(rows.map(text)).toEqual([
        '  grammar: a',
        '  small words: b',
        '  wording: c',
        '  spelling: "want" takes an infinitive with "to" and a few more words here and there ok  punctuation: Contraction needs an apostrophe  other: odd',
      ])
    })

    test('one group longer than 4 rows stops at row 4, cut with an ellipsis', async () => {
      const whys = Array.from({ length: 12 }, (_, i) => ['verb-form', `reason number ${i + 1}`] as [string, string])
      const rows = reasons(multi(...whys), 40)
      expect(rows).toHaveLength(4)
      expect(text(rows[3]!).endsWith('…')).toBe(true)
      expect(text(rows[0]!).startsWith('  grammar: reason number 1')).toBe(true)
    })

    test('other stays last and dim; unbounded width gives one row per group', async () => {
      const four = multi(['verb-form', long], ['article', long], ['word-choice', long], ['other', long])
      const rows = reasons(four, Infinity)
      expect(rows.map(text).map((t) => t.split(':')[0])).toEqual(['  grammar', '  small words', '  wording', '  other'])
      expect(rows.at(-1)!.segments![1]!.style).toEqual(DIM)
      const packed = reasons(example, 40)
      expect(packed.at(-1)!.segments!.at(-1)!.style).toEqual(DIM)
      expect(text(packed.at(-1)!).endsWith('other: odd')).toBe(true)
    })

    test('the reasons never take more than 4 rows', async () => {
      const mixes = [
        example,
        multi(['verb-form', long], ['article', long], ['comma', long], ['spelling', long], ['other', long]),
        multi(['verb-form', 'a'], ['article', 'b'], ['comma', 'c'], ['spelling', 'd'], ['word-choice', 'e'], ['other', 'f']),
        multi(['spelling', long + ' ' + long + ' ' + long]),
      ]
      for (const v of mixes) {
        for (const w of [10, 20, 30, 45, 60, 75, 120, Infinity]) {
          const n = reasons(v, w).length
          expect(n).toBeGreaterThan(0)
          expect(n).toBeLessThanOrEqual(4)
        }
      }
    })
  })

  test('each mute button carries the color of its group', async () => {
    const actions = mutesOf(actionOf(layout(grouped, { maxRows: 10 }).rows)!)
    expect(actions.map((a) => [a.key, a.color])).toEqual([
      ['mute:spelling', 'success'],
      ['mute:verb-form', 'warning'],
      ['mute:comma', 'claude'],
    ])
  })

  test('a repeated reason is listed once, and a group joins its reasons', async () => {
    const v = view([{ ...err(1), changes: [{ kind: 'article', why: 'a1' }, { kind: 'preposition', why: 'a2' }, { kind: 'article', why: 'a1' }, { kind: 'spelling', why: 'typo' }] }])
    expect(texts(layout(v, { maxRows: 10 }).rows).slice(1)).toEqual(['  small words: a1 · a2', '  spelling: typo'])
    expect(texts(layout(v, { maxRows: 10, muted: ['spelling'] }).rows).slice(1)).toEqual(['  small words: a1 · a2'])
  })

  test('only other kinds: the action row is the toggle and the hint, no mute button', async () => {
    const other = layout(otherView, { maxRows: 10 })
    expect(texts(other.rows)).toEqual(['✎ English · Sentence 1 there', '  other: why 1'])
    expect(other.rows).toHaveLength(3)
    expect(actionOf(other.rows)).toEqual({ actions: [{ ...TOGGLE, label: 'less' }], hint: 'ctrl+x tab' })
    expect(textRows(other.rows)[1]!.segments![1]).toEqual({ text: 'other: why 1', style: DIM })
    const single = actionOf(layout(view([err(1), err(2, 'comma')]), { maxRows: 10 }).rows)!
    expect(single.actions!.map((a) => a.key)).toEqual(['toggle', 'mute:article', 'mute:comma'])
  })

  test('other and unknown kinds get no mute button', async () => {
    const v = view([err(1, 'other'), err(2, 'other'), err(3, 'other'), err(4, 'other')])
    expect(mutesOf(actionOf(layout(v, { maxRows: 10 }).rows)!)).toEqual([])
    const mixed = view([err(1, 'tense-soup'), err(2, 'comma')])
    expect(mutesOf(actionOf(layout(mixed, { maxRows: 10 }).rows)!).map((a) => a.key)).toEqual(['mute:comma'])
  })

  test('at most 9 mute buttons, hotkeys a s d f g h j k l, letters only', async () => {
    const slugs = ['article', 'preposition', 'verb-form', 'agreement', 'word-order', 'word-choice', 'number', 'pronoun', 'apostrophe', 'comma', 'spelling', 'capitalization']
    const many = view([0, 1, 2].map((i) => ({ ...err(i), changes: slugs.slice(i * 4, i * 4 + 4).map((kind) => ({ kind, why: 'x' })) })))
    const wide = actionOf(layout(many, { maxRows: 10 }).rows)!
    expect(mutesOf(wide).map((a) => a.hotkey).join('')).toBe('asdfghjkl')
    expect(mutesOf(wide)).toHaveLength(9)
    const hotkeys = [four, view([err(1), err(2, 'comma')]), fixView]
      .flatMap((x) => [3, 5, 7, 10].flatMap((maxRows) => layout(x, { maxRows }).rows))
      .flatMap((r) => r.actions?.map((a) => a.hotkey) ?? [])
    expect(hotkeys.length).toBeGreaterThan(0)
    for (const h of [...hotkeys, ...wide.actions!.map((a) => a.hotkey)]) expect(h).toMatch(/^[a-z]$/)
  })

  test('a band taller than maxRows returns all its rows, with no gap', async () => {
    const l = layout(grouped, { maxRows: 2 })
    expect(l.gap).toBe(false)
    expect(l.rows).toHaveLength(6)
    expect(layout(grouped, { maxRows: 1 }).rows).toHaveLength(6)
  })

  test('the gap shows only when every row fits', async () => {
    const at = (maxRows: number) => layout(grouped, { maxRows }).gap
    expect([5, 6, 7].map(at)).toEqual([false, false, true])
  })

  test('a muted kind is drawn out of the text, the reasons and the buttons', async () => {
    const l = layout(four, { maxRows: 10, muted: ['apostrophe'] })
    expect(texts(l.rows)).toEqual([
      '✎ English · Sentence 1 here Sentence 2 there Sentence 3 here Sentence 4 there',
      '  spelling: why 4',
      '  punctuation: why 2',
    ])
    expect(mutesOf(actionOf(l.rows)!).map((a) => a.key)).toEqual(['mute:comma', 'mute:spelling'])
  })

  test('muted apostrophes: an apostrophe-only edit labelled spelling draws no highlight', async () => {
    const v = {
      kind: 'fix' as const,
      source: 'draft' as const,
      text: 'i dont know thing. Its fine',
      errors: [
        { original: 'i dont know thing', corrected: "i don't know the thing", changes: [{ kind: 'spelling', why: 'a' }, { kind: 'article', why: 'b' }] },
        { original: 'Its fine', corrected: "It's fine", changes: [{ kind: 'word-choice', why: 'c' }] },
      ],
    }
    const l = layout(v, { maxRows: 10, muted: ['apostrophe'] })
    expect(texts(l.rows)).toEqual(['✎ English · i dont know the thing. Its fine', '  small words: b', '  spelling: a'])
    const marked = textRows(l.rows)[0]!.segments!.filter((s) => (s.style as { bold?: boolean }).bold).map((s) => s.text)
    expect(marked).toEqual(['the'])
    expect(texts(layout(v, { maxRows: 10 }).rows)[0]).toBe("✎ English · i don't know the thing. It's fine")
  })

  test('a muted other is never filtered', async () => {
    expect(texts(layout(otherView, { maxRows: 5, muted: ['article', 'comma'] }).rows)).toHaveLength(2)
  })

  test('all errors muted reads "no errors"', async () => {
    const l = layout(four, { maxRows: 10, muted: ['apostrophe', 'comma', 'spelling'] })
    expect(l.gap).toBe(true)
    expect(texts(l.rows)).toEqual(['✓ English · no errors'])
    expect(texts(layout(view(four.errors, 'sent'), { maxRows: 1, muted: ['apostrophe', 'comma', 'spelling'] }).rows)).toEqual(['✓ English · sent · no errors'])
  })

  test('a narrow action row drops the hint first, then mute buttons from the end; the toggle stays while it fits', async () => {
    const full = actionOf(layout(four, { maxRows: 10 }).rows)!
    const at = (bodyColumns: number) => actionOf(layout(four, { maxRows: 10, bodyColumns }).rows)
    const keys = (r: Row | undefined) => r?.actions!.map((a) => a.key)
    expect(drawn(full)).toBe('  m: less  a: mute apostrophes  s: mute commas  d: mute spelling  ctrl+x tab')
    expect(at(76)!.hint).toBe('ctrl+x tab')
    // All three buttons fit without the hint (64), not with it (76).
    expect(keys(at(75))).toEqual(['toggle', 'mute:apostrophe', 'mute:comma', 'mute:spelling'])
    expect(at(75)!.hint).toBeUndefined()
    expect(at(64)!.hint).toBeUndefined()
    // Two buttons and the hint fit (58): the hint stays, the third button goes.
    expect(keys(at(63))).toEqual(['toggle', 'mute:apostrophe', 'mute:comma'])
    expect(at(63)!.hint).toBe('ctrl+x tab')
    expect(at(58)!.hint).toBe('ctrl+x tab')
    // Two buttons alone fit (46), with the hint they do not.
    expect(keys(at(57))).toEqual(['toggle', 'mute:apostrophe', 'mute:comma'])
    expect(at(57)!.hint).toBeUndefined()
    expect(at(46)!.hint).toBeUndefined()
    // One button and the hint fit (42).
    expect(keys(at(45))).toEqual(['toggle', 'mute:apostrophe'])
    expect(at(45)!.hint).toBe('ctrl+x tab')
    expect(at(42)!.hint).toBe('ctrl+x tab')
    expect(keys(at(41))).toEqual(['toggle', 'mute:apostrophe'])
    expect(at(41)!.hint).toBeUndefined()
    expect(at(30)!.hint).toBeUndefined()
    // The toggle and the hint fit (21); the toggle alone (9).
    expect(keys(at(29))).toEqual(['toggle'])
    expect(at(29)!.hint).toBe('ctrl+x tab')
    expect(at(21)!.hint).toBe('ctrl+x tab')
    expect(at(20)!.hint).toBeUndefined()
    expect(keys(at(9))).toEqual(['toggle'])
    expect(at(8)).toBeUndefined()
  })

  test('at 55 columns the toggle and two buttons fit, the hint does not', async () => {
    // The real session: bodyColumns 55 (a 60-column pane less the engine's 5), three or more mute kinds.
    const kinds = view([err(1, 'verb-form'), err(2, 'article'), err(3, 'spelling'), err(4, 'comma')])
    const row = actionOf(layout(kinds, { maxRows: 10, bodyColumns: 55 }).rows)!
    expect(row.actions!.map((a) => a.key)).toEqual(['toggle', 'mute:verb-form', 'mute:article'])
    expect(drawn(row)).toBe('  m: less  a: mute verb forms  s: mute articles')
    expect(drawn(row).length).toBeLessThanOrEqual(55)
    const minimal = actionOf(layout(kinds, { maxRows: 10, bodyColumns: 55, expanded: false }).rows)!
    expect(drawn(minimal)).toBe('  m: more  ctrl+x tab')
  })

  test('with no room for even one mute button the toggle row has the toggle alone', async () => {
    const rows = layout(fixView, { maxRows: 10, bodyColumns: 10 }).rows
    expect(rows.filter((r) => r.actions)).toEqual([{ actions: [{ ...TOGGLE, label: 'less' }], hint: undefined }])
    expect(texts(rows).at(-1)).toBe('    missing to')
  })

  describe('minimal mode', () => {
    const minimal = (v: Parameters<typeof bandRows>[0], opts: Parameters<typeof bandRows>[1] = { maxRows: 10 }) => layout(v, { ...opts, expanded: false })

    test('is the default: the fixed text, then the toggle row with `more` and the hint', async () => {
      const l = bandRows(fixView, { maxRows: 10 }) as unknown as { gap: boolean; rows: Row[] }
      expect(texts(l.rows)).toEqual(['✎ English · I want to check it'])
      expect(l.rows).toHaveLength(2)
      expect(actionOf(l.rows)).toEqual({ actions: [{ ...TOGGLE, label: 'more' }], hint: 'ctrl+x tab' })
      expect(drawn(actionOf(l.rows)!)).toBe('  m: more  ctrl+x tab')
      expect(l).toEqual(minimal(fixView))
    })

    test('has no reasons rows and no mute button, whatever the view', async () => {
      for (const v of [fixView, otherView, four, grouped]) {
        const l = minimal(v)
        expect(textRows(l.rows)).toHaveLength(1)
        expect(l.rows).toHaveLength(2)
        expect(l.rows.at(-1)!.actions!.map((a) => a.key)).toEqual(['toggle'])
        expect(JSON.stringify(l)).not.toContain('mute:')
      }
    })

    test('wrapped text rows come before the toggle row', async () => {
      const l = minimal(fixView, { maxRows: 10, bodyColumns: 24 })
      expect(texts(l.rows)).toEqual(['✎ English · I want to', '  check it'])
      expect(l.rows).toHaveLength(3)
      expect(l.rows[2]!.actions).toBeDefined()
    })

    test('a narrow toggle row drops the hint, then the row', async () => {
      const at = (bodyColumns: number) => actionOf(minimal(fixView, { maxRows: 10, bodyColumns }).rows)
      expect(at(21)!.hint).toBe('ctrl+x tab')
      expect(at(20)!.hint).toBeUndefined()
      expect(at(20)!.actions!.map((a) => a.key)).toEqual(['toggle'])
      expect(at(9)).toBeDefined()
      expect(at(8)).toBeUndefined()
    })

    test('no toggle row when expanding would add nothing: no reasons and no mute button', async () => {
      // An apostrophe-only edit labelled spelling is reverted when apostrophes are muted: no change is left to explain.
      const reverted = {
        kind: 'fix' as const,
        source: 'draft' as const,
        text: 'i dont know thing',
        errors: [{ original: 'i dont know thing', corrected: "i don't know the thing", changes: [{ kind: 'spelling', why: 'Use apostrophe in contraction' }] }],
      }
      for (const expanded of [false, true]) {
        const l = layout(reverted, { maxRows: 10, muted: ['apostrophe'], expanded })
        expect(texts(l.rows)).toEqual(['✎ English · i dont know the thing'])
        expect(l.rows).toHaveLength(1)
      }
      expect(layout(reverted, { maxRows: 10, expanded: false }).rows).toHaveLength(2)
    })

    test('the gap is computed on the rows drawn', async () => {
      // Text row + toggle row = 2 rows: the gap from 3 rows.
      expect([1, 2, 3].map((maxRows) => minimal(fixView, { maxRows }).gap)).toEqual([false, false, true])
      expect(layout(fixView, { maxRows: 3 }).gap).toBe(false)
      expect([1, 2, 3].map((maxRows) => minimal(fixView, { maxRows }).rows.length)).toEqual([2, 2, 2])
    })

    test('ok and all-muted views do not change', async () => {
      const ok = { kind: 'ok' as const, source: 'draft' as const }
      expect(minimal(ok, { maxRows: 5 })).toEqual(layout(ok, { maxRows: 5, expanded: true }))
      expect(texts(minimal(ok).rows)).toEqual(['✓ English · no errors'])
      const muted = ['apostrophe', 'comma', 'spelling']
      expect(minimal(four, { maxRows: 10, muted })).toEqual(layout(four, { maxRows: 10, muted }))
      expect(texts(minimal(four, { maxRows: 10, muted }).rows)).toEqual(['✓ English · no errors'])
    })
  })

  describe('expanded mode', () => {
    test('is text rows, reasons rows, then the action row with `less` first, the mute buttons, the hint', async () => {
      const l = layout(four, { maxRows: 10, bodyColumns: Infinity })
      expect(texts(l.rows)).toEqual([
        '✎ English · Sentence 1 there Sentence 2 there Sentence 3 there Sentence 4 there',
        '  spelling: why 4',
        '  punctuation: why 1 · why 2 · why 3',
      ])
      expect(l.rows.at(-1)!.actions!.map((a) => [a.key, a.hotkey, a.label])).toEqual([
        ['toggle', 'm', 'less'],
        ['mute:apostrophe', 'a', 'mute apostrophes'],
        ['mute:comma', 's', 'mute commas'],
        ['mute:spelling', 'd', 'mute spelling'],
      ])
      expect(l.rows.at(-1)!.actions![0]).not.toHaveProperty('color')
      expect(l.rows.at(-1)!.hint).toBe('ctrl+x tab')
    })
  })

  test('sent tag only for source sent', async () => {
    expect(text(textRows(layout(fixView, { maxRows: 3 }).rows)[0]!)).not.toContain('sent ·')
    const { rows } = layout({ ...fixView, source: 'sent' }, { maxRows: 3 })
    expect(text(textRows(rows)[0]!)).toBe('✎ English · sent · I want to check it')
    expect(textRows(rows)[0]!.segments![1]).toEqual({ text: 'English · sent · ', style: DIM })
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
    grouped,
    { ...four, source: 'sent' as const },
    view([err(1), err(2, 'comma')]),
    view(Array.from({ length: 8 }, (_, i) => err(i, i % 2 ? 'other' : 'comma'))),
    { kind: 'ok' as const, source: 'draft' as const },
    { kind: 'ok' as const, source: 'sent' as const },
  ]

  test('the gap is set only when it and every row fit in maxRows', async () => {
    for (const v of allViews) {
      for (const maxRows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        for (const opts of [{}, { muted: ['comma'] }, { bodyColumns: 30 }, { bodyColumns: 12 }]) {
          const { gap, rows } = layout(v, { maxRows, ...opts })
          expect(rows.length).toBeGreaterThan(0)
          if (gap) expect(rows.length + 1).toBeLessThanOrEqual(maxRows)
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

  test('no page key, text or count anywhere', async () => {
    for (const v of allViews) {
      const l = layout(v, { maxRows: 10 })
      expect(Object.keys(l).sort()).toEqual(['gap', 'rows'])
      expect(JSON.stringify(l)).not.toMatch(/page|‹/)
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
      const rows = bandRows({ kind: 'fix', source: 'draft', text: mixedErr.original, errors: [mixedErr] }, { maxRows: 6, muted })
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
    for (const s of ['{"ok":true}', '{"skip":true}', '"errors"', '"changes"', '"kind"', '"words"', '"why"', '40 words', 'not English', 'in the order', 'at most 8']) {
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

describe('parseErrors words', () => {
  const reply = (changes: unknown[]) =>
    JSON.stringify({ errors: [{ original: 'I want that you checks my text.', corrected: 'I want you to check my text.', changes }] })
  const changesOf = (changes: unknown[]) => (parseErrors(reply(changes), SENT) as { errors: { changes: unknown[] }[] }).errors[0].changes

  test('a words string is kept, whitespace normalized', async () => {
    expect(changesOf([{ kind: 'verb-form', why: 'x', words: '  you  to\ncheck ' }])).toEqual([{ kind: 'verb-form', why: 'x', words: 'you to check' }])
  })

  test('missing, empty, blank and non-string words leave no property', async () => {
    for (const words of [undefined, '', '   ', 3, null, ['a'], { a: 1 }]) {
      const [change] = changesOf([{ kind: 'verb-form', why: 'x', words }]) as Record<string, unknown>[]
      expect(change).toEqual({ kind: 'verb-form', why: 'x' })
      expect('words' in change).toBe(false)
    }
  })
})

describe('GROUPS and groupOf', () => {
  test('five groups in order, with theme-key colors', async () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['grammar', 'small words', 'wording', 'spelling', 'punctuation'])
    expect(GROUPS.map((g) => g.color)).toEqual(['warning', 'ide', 'autoAccept', 'success', 'claude'])
    expect(GROUPS.map((g) => g.kinds)).toEqual([
      ['verb-form', 'agreement', 'number', 'pronoun'],
      ['article', 'preposition'],
      ['word-choice', 'word-order'],
      ['spelling', 'capitalization'],
      ['apostrophe', 'comma'],
    ])
  })

  test('every kind is in exactly one group', async () => {
    for (const { slug } of KINDS) expect(GROUPS.filter((g) => g.kinds.includes(slug))).toHaveLength(1)
  })

  test('groupOf finds the group, or null', async () => {
    expect(groupOf('article')).toBe(GROUPS[1])
    expect(groupOf('comma')).toBe(GROUPS[4])
    expect(groupOf('other')).toBeNull()
    expect(groupOf('nope')).toBeNull()
  })
})

describe('fixedTokens', () => {
  const change = (kind: string, words?: string, why = 'w') => ({ kind, why, ...(words === undefined ? {} : { words }) })
  const err = (original: string, corrected: string, changes: ReturnType<typeof change>[]) => ({ original, corrected, changes })
  const WARN = { color: 'warning', bold: true }
  const SMALL = { color: 'ide', bold: true }
  const NEUTRAL = { bold: true }
  const DIMMED = { dimColor: true }
  const join = (tokens: { text: string; space: boolean }[]) => tokens.map((t, i) => (t.space && i > 0 ? ' ' : '') + t.text).join('')
  const styleOf = (tokens: { text: string; style: object }[], word: string) => tokens.find((t) => t.text === word)?.style

  test('a fix replaces its original; tokens carry space and plain style', async () => {
    const tokens = fixedTokens('I want that you checks my text', [err('want that you checks', 'want you to check', [change('verb-form', 'you to check')])], [])
    expect(join(tokens)).toBe('I want you to check my text')
    expect(tokens[0]).toEqual({ text: 'I', space: false, style: {} })
    expect(tokens.map((t) => t.space)).toEqual([false, true, true, true, true, true, true])
    expect(tokens.map((t) => t.style)).toEqual([{}, {}, {}, WARN, WARN, {}, {}])
  })

  test('two errors are placed in order, in their own places', async () => {
    const text = 'He go home. She like tea.'
    const tokens = fixedTokens(text, [err('He go home.', 'He goes home.', [change('verb-form', 'goes')]), err('She like tea.', 'She likes tea.', [change('verb-form', 'likes')])], [])
    expect(join(tokens)).toBe('He goes home. She likes tea.')
    expect(tokens.filter((t) => t.style !== undefined && Object.keys(t.style).length > 0).map((t) => t.text)).toEqual(['goes', 'likes'])
  })

  test('an error placed after the cursor: a repeat of the first text matches the later occurrence', async () => {
    const text = 'a b c d. a b c d.'
    const tokens = fixedTokens(text, [err('a b c d.', 'a b c e.', [change('word-choice', 'e.')]), err('a b c d.', 'a b c f.', [change('word-choice', 'f.')])], [])
    expect(join(tokens)).toBe('a b c e. a b c f.')
  })

  test('an error that is not found after the cursor changes no text', async () => {
    const text = 'Second one here. First one here.'
    const tokens = fixedTokens(
      text,
      [err('First one here.', 'First one there.', [change('word-choice', 'there.')]), err('Second one here.', 'Second one there.', [change('word-choice', 'there.')])],
      [],
    )
    expect(join(tokens)).toBe('Second one here. First one there.')
  })

  test('an original inside a longer word is not a match', async () => {
    const tokens = fixedTokens('xthe cat sat. the cat sat.', [err('the cat', 'a cat', [change('article', 'a')])], [])
    expect(join(tokens)).toBe('xthe cat sat. a cat sat.')
  })

  test('a quote ending before a comma keeps the comma attached', async () => {
    const tokens = fixedTokens('Please check my texts, and tell me.', [err('check my texts', 'check my text', [change('number', 'text')])], [])
    expect(join(tokens)).toBe('Please check my text, and tell me.')
    expect(tokens.map((t) => [t.text, t.space]).filter(([t]) => t === 'text' || t === ',')).toEqual([['text', true], [',', false]])
  })

  test('a quote inside parentheses keeps the parenthesis attached', async () => {
    const tokens = fixedTokens('Note (I has a dog) here.', [err('I has', 'I have', [change('agreement', 'have')])], [])
    expect(join(tokens)).toBe('Note (I have a dog) here.')
    expect(tokens.slice(1, 3).map((t) => [t.text, t.space])).toEqual([['(', true], ['I', false]])
  })

  test('the changed word is matched by words, ignoring punctuation and case', async () => {
    const e = err('He go home, now', 'He Goes home, now', [change('verb-form', 'goes.'), change('comma', ',')])
    const tokens = fixedTokens('He go home, now', [e], [])
    expect(styleOf(tokens, 'Goes')).toEqual(WARN)
  })

  test('each changed word takes the group of its own change', async () => {
    const e = err('I has a apple', 'I have an apple', [change('agreement', 'have'), change('article', 'an')])
    const tokens = fixedTokens('I has a apple', [e], [])
    expect(styleOf(tokens, 'have')).toEqual(WARN)
    expect(styleOf(tokens, 'an')).toEqual(SMALL)
    expect(styleOf(tokens, 'apple')).toEqual({})
  })

  test('no match: all raw changes in one group colors the word', async () => {
    const e = err('I has go', 'I have gone', [change('agreement', 'zzz'), change('verb-form')])
    expect(fixedTokens('I has go', [e], []).filter((t) => t.text === 'have' || t.text === 'gone').map((t) => t.style)).toEqual([WARN, WARN])
  })

  test('no match: mixed groups are neutral', async () => {
    const e = err('I has a apple', 'I have an apple', [change('agreement'), change('article')])
    const tokens = fixedTokens('I has a apple', [e], [])
    expect(styleOf(tokens, 'have')).toEqual(NEUTRAL)
    expect(styleOf(tokens, 'an')).toEqual(NEUTRAL)
  })

  test('no match: a group with an `other` change is neutral', async () => {
    const e = err('I has it', 'I have it', [change('agreement'), change('other')])
    expect(styleOf(fixedTokens('I has it', [e], []), 'have')).toEqual(NEUTRAL)
  })

  test('a change of a muted kind is drawn plain', async () => {
    const e = err('I has a apple', 'I have an apple', [change('agreement', 'have'), change('article', 'an')])
    const tokens = fixedTokens('I has a apple', [e], ['article'])
    expect(styleOf(tokens, 'an')).toEqual({})
    expect(styleOf(tokens, 'have')).toEqual(WARN)
  })

  test('no match with a muted raw change in the error: neutral, not the shared group', async () => {
    const e = err('I has a apple', 'I have an apple', [change('agreement'), change('article')])
    const tokens = fixedTokens('I has a apple', [e], ['article'])
    expect(styleOf(tokens, 'have')).toEqual(NEUTRAL)
  })

  test('a matched `other` change is neutral', async () => {
    const e = err('I has a apple', 'I have an apple', [change('agreement', 'have'), change('other', 'an')])
    const tokens = fixedTokens('I has a apple', [e], [])
    expect(styleOf(tokens, 'an')).toEqual(NEUTRAL)
    expect(styleOf(tokens, 'have')).toEqual(WARN)
  })

  test('an error with no visible change left is neutral', async () => {
    const gone = err('I dont know', "I don't know now", [change('spelling', undefined, 'dont is a contraction')])
    const out = fixedTokens('I dont know', [gone], ['apostrophe'])
    expect(join(out)).toBe('I dont know now')
    expect(styleOf(out, 'now')).toEqual(NEUTRAL)
  })

  test('a muted error is not spliced', async () => {
    const e = err('I has it', 'I have it', [change('agreement', 'have')])
    expect(join(fixedTokens('I has it', [e], ['agreement']))).toBe('I has it')
  })

  test('a pure removal changes the text and marks nothing', async () => {
    const tokens = fixedTokens('I really has it', [err('really has', 'has', [change('word-choice')])], [])
    expect(join(tokens)).toBe('I has it')
    expect(tokens.every((t) => Object.keys(t.style).length === 0)).toBe(true)
  })

  const numbered = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `w${from + i}`)

  test('a short text is not cut', async () => {
    const text = 'w0 w1 w2 has x w3 w4 w5'
    const tokens = fixedTokens(text, [err('w2 has x', 'w2 have x', [change('agreement', 'have')])], [])
    expect(join(tokens)).toBe('w0 w1 w2 have x w3 w4 w5')
    expect(tokens.some((t) => t.text === '…')).toBe(false)
  })

  test('a long middle gap becomes one dim …', async () => {
    const text = `a b c d e. ${numbered(30).join(' ')} f g h i j. k l m n o p`
    const tokens = fixedTokens(
      text,
      [err('a b c d e.', 'a b c d E.', [change('capitalization', 'E.')]), err('f g h i j.', 'f g h i J.', [change('capitalization', 'J.')])],
      [],
    )
    expect(join(tokens)).toBe('a b c d E. w0 w1 w2 w3 … f g h i J. k l m n …')
    expect(tokens.find((t) => t.text === '…')).toEqual({ text: '…', space: true, style: DIMMED })
  })

  test('a long start and end are cut with a leading and a trailing …', async () => {
    const text = `${numbered(20).join(' ')} the dogs run ${numbered(20, 40).join(' ')}`
    const tokens = fixedTokens(text, [err('the dogs run', 'the dog runs', [change('number', 'dog'), change('agreement', 'runs')])], [])
    expect(join(tokens)).toBe('… w17 w18 w19 the dog runs w40 w41 w42 w43 …')
    expect(tokens[0]).toEqual({ text: '…', space: false, style: DIMMED })
    expect(tokens[tokens.length - 1].style).toEqual(DIMMED)
  })

  test('with no changed token, the first 8 tokens and …', async () => {
    const text = numbered(20).join(' ')
    expect(join(fixedTokens(text, [], []))).toBe(`${numbered(8).join(' ')} …`)
  })

  test('a removal-only fix is shown in context: 4 tokens each side, no mark', async () => {
    const text = `${numbered(20).join(' ')} really ${numbered(20, 40).join(' ')}`
    const tokens = fixedTokens(text, [err('w19 really', 'w19', [change('word-choice')])], [])
    expect(join(tokens)).toBe('… w16 w17 w18 w19 w40 w41 w42 w43 …')
    expect(tokens.filter((t) => t.text !== '…').every((t) => Object.keys(t.style).length === 0)).toBe(true)
  })

  test('a removal at the very start or end keeps its context too', async () => {
    const head = fixedTokens(`really ${numbered(20).join(' ')}`, [err('really w0', 'w0', [change('word-choice')])], [])
    expect(join(head)).toBe('w0 w1 w2 w3 …')
    const tail = fixedTokens(`${numbered(20).join(' ')} really`, [err('w19 really', 'w19', [change('word-choice')])], [])
    expect(join(tail)).toBe('… w16 w17 w18 w19')
  })

  test('a removal inside a rewrite counts at its place', async () => {
    const text = `${numbered(20).join(' ')} a very big dog ${numbered(20, 40).join(' ')}`
    const tokens = fixedTokens(text, [err('a very big dog', 'a big dog', [change('word-choice')])], [])
    expect(join(tokens)).toBe('… w17 w18 w19 a big dog w40 w41 …')
  })

  test('a text of up to 9 tokens with no change is not cut (a … would hide one token)', async () => {
    expect(join(fixedTokens(numbered(8).join(' '), [], []))).toBe(numbered(8).join(' '))
    expect(join(fixedTokens(numbered(9).join(' '), [], []))).toBe(numbered(9).join(' '))
    expect(join(fixedTokens(numbered(10).join(' '), [], []))).toBe(`${numbered(8).join(' ')} …`)
  })

  test('a gap of one token is shown; a gap of two is cut', async () => {
    const mid = (n: number) => `A ${numbered(n).join(' ')} B`
    const two = (n: number) => fixedTokens(mid(n), [err('A', 'a', [change('capitalization', 'a')]), err('B', 'b', [change('capitalization', 'b')])], [])
    expect(join(two(9))).toBe('a w0 w1 w2 w3 w4 w5 w6 w7 w8 b')
    expect(join(two(10))).toBe('a w0 w1 w2 w3 … w6 w7 w8 w9 b')
    expect(join(two(11))).toBe('a w0 w1 w2 w3 … w7 w8 w9 w10 b')
  })

  test('a leading or trailing stretch of one token is shown', async () => {
    const e = err('x', 'X', [change('capitalization', 'X')])
    expect(join(fixedTokens(`${numbered(5).join(' ')} x`, [e], []))).toBe('w0 w1 w2 w3 w4 X')
    expect(join(fixedTokens(`${numbered(6).join(' ')} x`, [e], []))).toBe('… w2 w3 w4 w5 X')
    expect(join(fixedTokens(`x ${numbered(5).join(' ')}`, [e], []))).toBe('X w0 w1 w2 w3 w4')
    expect(join(fixedTokens(`x ${numbered(6).join(' ')}`, [e], []))).toBe('X w0 w1 w2 w3 …')
  })
})

describe('wrapTokens', () => {
  const tok = (text: string, space = true) => ({ text, space, style: {} })
  const words = (s: string) => s.split(' ').map((w, i) => tok(w, i > 0))
  const show = (lines: { text: string; space: boolean }[][]) => lines.map((l) => l.map((t, i) => (t.space && i > 0 ? ' ' : '') + t.text).join(''))

  test('greedy lines within the width', async () => {
    const lines = wrapTokens(words('aaaa bbbb cccc dddd eeee ffff'), 20, 2)
    expect(show(lines)).toEqual(['aaaa bbbb cccc dddd', 'eeee ffff'])
  })

  test('the first line holds the prefix tokens; later lines count the indent', async () => {
    const tokens = [tok('✎ ', false), tok('English · ', false), tok('one', false), ...words('two three four five six seven').map((t) => ({ ...t, space: true }))]
    const lines = wrapTokens(tokens, 28, 2)
    expect(show(lines)).toEqual(['✎ English · one two three', 'four five six seven'])
    expect(lines[1][0].space).toBe(false)
  })

  test('a continuation line is cut at columns minus the indent', async () => {
    const tokens = words('aaaaaaaaa bbbbbbbbb cccccccc dddddddd')
    expect(show(wrapTokens(tokens, 20, 2))).toEqual(['aaaaaaaaa bbbbbbbbb', 'cccccccc dddddddd'])
    expect(show(wrapTokens(tokens, 20, 4))).toEqual(['aaaaaaaaa bbbbbbbbb', 'cccccccc', 'dddddddd'])
  })

  test('columns under 20 are read as 20', async () => {
    const tokens = words('aaaa bbbb cccc dddd eeee')
    expect(wrapTokens(tokens, 5, 2)).toEqual(wrapTokens(tokens, 20, 2))
    expect(show(wrapTokens(tokens, 5, 2))).toEqual(['aaaa bbbb cccc dddd', 'eeee'])
  })

  test('a token with no space before it stays with the one before it', async () => {
    const lines = wrapTokens([tok('aaaaaaaaaa', false), tok('bbbbbbbbb'), tok(',', false), tok('cc')], 20, 2)
    expect(show(lines)).toEqual(['aaaaaaaaaa', 'bbbbbbbbb, cc'])
  })

  test('a token marked breakBefore may start a line though no space precedes it', async () => {
    const tokens = [tok('✎ ', false), tok('English · ', false), { ...tok('Internationalisation', false), breakBefore: true }, tok('is'), tok('hard')]
    expect(show(wrapTokens(tokens, 30, 2))).toEqual(['✎ English · ', 'Internationalisation is hard'])
    expect(show(wrapTokens(tokens, 38, 2))).toEqual(['✎ English · Internationalisation is', 'hard'])
  })

  test('a token wider than a line gets a line to itself', async () => {
    const lines = wrapTokens([tok('aa', false), tok('x'.repeat(30)), tok('bb')], 20, 2)
    expect(show(lines)).toEqual(['aa', 'x'.repeat(30), 'bb'])
  })

  test('no tokens, no lines', async () => {
    expect(wrapTokens([], 40, 2)).toEqual([])
  })
})

describe('groupReasons', () => {
  const e = (...changes: [string, string][]) => ({ original: 'a b', corrected: 'a c', changes: changes.map(([kind, why]) => ({ kind, why })) })

  test('one entry per group present, in GROUPS order, other last', async () => {
    const out = groupReasons([e(['other', 'odd'], ['comma', 'pause']), e(['article', 'the'], ['verb-form', 'past'])])
    expect(out).toEqual([
      { group: GROUPS[0], whys: ['past'] },
      { group: GROUPS[1], whys: ['the'] },
      { group: GROUPS[4], whys: ['pause'] },
      { group: null, whys: ['odd'] },
    ])
  })

  test('reasons keep their order within a group; a repeat is listed once', async () => {
    const out = groupReasons([e(['agreement', 'one'], ['number', 'two']), e(['pronoun', 'one'], ['verb-form', 'three'])])
    expect(out).toEqual([{ group: GROUPS[0], whys: ['one', 'two', 'three'] }])
  })

  test('an unknown kind counts as other; no errors, no entries', async () => {
    expect(groupReasons([e(['nope', 'x'])])).toEqual([{ group: null, whys: ['x'] }])
    expect(groupReasons([])).toEqual([])
  })
})
