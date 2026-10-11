import { describe, expect, test } from 'claude-code/testing'
import { RULES, bandRows, diffWords, normalizeWhitespace, parseReply, prepareDraft } from '../hooks/lib.js'

const SENT = 'I want that you checks my text. It is fine here.'
const fix = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    count: 1,
    last: { original: 'I want that you checks my text.', corrected: 'I want you to check my text.', why: 'want + object · verb form' },
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

describe('parseReply', () => {
  test('ok', async () => {
    expect(parseReply('{"ok":true}', SENT)).toBe('ok')
  })

  test('skip', async () => {
    expect(parseReply('{"skip":true}', SENT)).toBe('skip')
  })

  test('count + last', async () => {
    expect(parseReply(fix({ count: 3 }), SENT)).toEqual({
      original: 'I want that you checks my text.',
      corrected: 'I want you to check my text.',
      why: 'want + object · verb form',
      more: 2,
    })
  })

  test('count 1 gives more 0', async () => {
    expect((parseReply(fix(), SENT) as { more: number }).more).toBe(0)
  })

  test('malformed and empty replies give nothing', async () => {
    expect(parseReply('', SENT)).toBeNull()
    expect(parseReply('no json here', SENT)).toBeNull()
    expect(parseReply('{not json}', SENT)).toBeNull()
    expect(parseReply('[1,2]', SENT)).toBeNull()
    expect(parseReply('{"foo":1}', SENT)).toBeNull()
  })

  test('truncated JSON gives nothing', async () => {
    expect(parseReply(fix().slice(0, 60), SENT)).toBeNull()
  })

  test('prose around the JSON: first object is taken', async () => {
    const reply = `Here you go: {"ok":true} and also {"skip":true} thanks`
    expect(parseReply(reply, SENT)).toBe('ok')
  })

  test('```json fenced reply', async () => {
    expect(parseReply('```json\n' + fix() + '\n```', SENT)).not.toBeNull()
    expect(parseReply('```json\n{"ok":true}\n```', SENT)).toBe('ok')
  })

  test('braces inside strings do not end the object early', async () => {
    const reply = '{"count":1,"last":{"original":"I want that you checks my text.","corrected":"I want {you} to check my text.","why":"a } b"}}'
    expect((parseReply(reply, SENT) as { why: string }).why).toBe('a } b')
  })

  test('count "2" or 1.5 gives nothing', async () => {
    expect(parseReply(fix({ count: '2' }), SENT)).toBeNull()
    expect(parseReply(fix({ count: 1.5 }), SENT)).toBeNull()
    expect(parseReply(fix({ count: -1 }), SENT)).toBeNull()
  })

  test('count missing with a valid last is 1', async () => {
    const reply = JSON.stringify({
      last: { original: 'I want that you checks my text.', corrected: 'I want you to check my text.', why: 'x' },
    })
    expect((parseReply(reply, SENT) as { more: number }).more).toBe(0)
  })

  test('count 0 is ok', async () => {
    expect(parseReply('{"count":0}', SENT)).toBe('ok')
  })

  test('count >= 1 without a valid last gives nothing', async () => {
    expect(parseReply('{"count":2}', SENT)).toBeNull()
    expect(parseReply('{"count":2,"last":{"original":"x"}}', SENT)).toBeNull()
  })

  test('corrected equal to original (after normalization) gives nothing', async () => {
    const reply = JSON.stringify({
      count: 1,
      last: { original: 'I want that you checks my text.', corrected: 'I  want that you\nchecks my text.', why: 'x' },
    })
    expect(parseReply(reply, SENT)).toBeNull()
  })

  test('original matched after whitespace normalization', async () => {
    const sent = 'I want that   you\nchecks my text. It is fine.'
    expect(parseReply(fix(), sent)).not.toBeNull()
  })

  test('original not found in the sent text gives nothing', async () => {
    expect(parseReply(fix(), 'Something else entirely, with no match.')).toBeNull()
  })
})

describe('parseReply quote matching', () => {
  const quote = (original: string) => JSON.stringify({ count: 1, last: { original, corrected: original + ' fixed', why: 'x' } })

  test('a fragment inside a longer word is rejected', async () => {
    expect(parseReply(quote('he is'), 'the is fine here')).toBeNull()
    expect(parseReply(quote('is fine'), 'this fine here')).toBeNull()
    expect(parseReply(quote('fine he'), 'fine here')).toBeNull()
  })

  test('a one-word quote is rejected even when it is a whole word', async () => {
    expect(parseReply(quote('text.'), SENT)).toBeNull()
    expect(parseReply(quote('text'), SENT)).toBeNull()
  })

  test('a whole-word run of 2 or more words inside the sentence is accepted', async () => {
    expect(parseReply(quote('want that'), SENT)).not.toBeNull()
    expect(parseReply(quote('checks my text'), SENT)).not.toBeNull()
  })

  test('a later whole-word occurrence is found after an earlier partial one', async () => {
    expect(parseReply(quote('he is'), 'the is, he is here')).not.toBeNull()
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

describe('bandRows', () => {
  const fixView = {
    kind: 'fix' as const,
    source: 'draft' as const,
    original: 'I want check it',
    corrected: 'I want to check it',
    why: 'missing to',
    more: 0,
  }
  const text = (r: { segments: { text: string }[] }) => r.segments.map((s) => s.text).join('')

  const ACCENT = { color: 'suggestion' }
  const DIM = { dimColor: true }

  test('fix: gap and two rows when maxRows >= 3', async () => {
    const { gap, rows } = bandRows(fixView, { maxRows: 3 })
    expect(gap).toBe(true)
    expect(rows).toHaveLength(2)
    expect(text(rows[0]!)).toBe('✎ English · I want to check it')
    expect(rows[0]!.segments.slice(0, 2)).toEqual([
      { text: '✎ ', style: ACCENT },
      { text: 'English · ', style: DIM },
    ])
    expect(text(rows[1]!)).toBe('  missing to')
    expect(rows[1]!.segments).toEqual([
      { text: '  ', style: {} },
      { text: 'missing to', style: DIM },
    ])
  })

  test('fix: two rows and no gap at maxRows 2', async () => {
    const { gap, rows } = bandRows(fixView, { maxRows: 2 })
    expect(gap).toBe(false)
    expect(rows).toHaveLength(2)
  })

  test('changed words are styled, others plain', async () => {
    const segs = bandRows(fixView, { maxRows: 3 }).rows[0]!.segments
    expect(segs).toContainEqual({ text: ' to', style: { color: 'diffAddedWord', bold: true } })
    expect(segs).toContainEqual({ text: 'I want', style: {} })
    expect(segs).toContainEqual({ text: ' check it', style: {} })
  })

  test('fix: one row, no gap when maxRows < 2, why on the same row', async () => {
    const { gap, rows } = bandRows(fixView, { maxRows: 1 })
    expect(gap).toBe(false)
    expect(rows).toHaveLength(1)
    expect(text(rows[0]!)).toBe('✎ English · I want to check it · missing to')
  })

  test('sent tag only for source sent', async () => {
    expect(text(bandRows(fixView, { maxRows: 3 }).rows[0]!)).not.toContain('sent ·')
    const { rows } = bandRows({ ...fixView, source: 'sent' }, { maxRows: 3 })
    expect(text(rows[0]!)).toBe('✎ English · sent · I want to check it')
    expect(rows[0]!.segments[1]).toEqual({ text: 'English · sent · ', style: DIM })
  })

  test('+N more only when more > 0', async () => {
    expect(text(bandRows(fixView, { maxRows: 3 }).rows[0]!)).not.toContain('more')
    const { rows } = bandRows({ ...fixView, more: 2 }, { maxRows: 3 })
    expect(text(rows[0]!)).toBe('✎ English · I want to check it  +2 more')
    expect(rows[0]!.segments.at(-1)).toEqual({ text: '  +2 more', style: DIM })
    expect(text(bandRows({ ...fixView, more: 2 }, { maxRows: 1 }).rows[0]!)).toBe(
      '✎ English · I want to check it  +2 more · missing to',
    )
  })

  test('ok rows', async () => {
    const draft = bandRows({ kind: 'ok', source: 'draft' }, { maxRows: 2 })
    expect(draft.gap).toBe(true)
    expect(draft.rows).toHaveLength(1)
    expect(draft.rows[0]!.segments).toEqual([
      { text: '✓ ', style: ACCENT },
      { text: 'English · ', style: DIM },
      { text: 'no errors', style: DIM },
    ])
    expect(text(draft.rows[0]!)).toBe('✓ English · no errors')
    const sent = bandRows({ kind: 'ok', source: 'sent' }, { maxRows: 1 })
    expect(sent.gap).toBe(false)
    expect(sent.rows).toHaveLength(1)
    expect(text(sent.rows[0]!)).toBe('✓ English · sent · no errors')
  })

  test('gap by maxRows', async () => {
    const ok = { kind: 'ok' as const, source: 'draft' as const }
    expect([0, 1, 2, 3].map((maxRows) => bandRows(fixView, { maxRows }).gap)).toEqual([false, false, false, true])
    expect([0, 1, 2, 3].map((maxRows) => bandRows(ok, { maxRows }).gap)).toEqual([false, false, true, true])
    expect(bandRows(fixView, { maxRows: 0 })).toEqual({ gap: false, rows: [] })
    expect(bandRows(ok, { maxRows: 0 })).toEqual({ gap: false, rows: [] })
  })

  const allViews = [
    fixView,
    { ...fixView, source: 'sent' as const, more: 1 },
    { kind: 'ok' as const, source: 'draft' as const },
    { kind: 'ok' as const, source: 'sent' as const },
  ]

  test('rows plus gap never exceed maxRows', async () => {
    for (const view of allViews) {
      for (const maxRows of [0, 1, 2, 3, 4]) {
        const { gap, rows } = bandRows(view, { maxRows })
        expect(rows.length + (gap ? 1 : 0)).toBeLessThanOrEqual(maxRows)
      }
    }
  })

  test('every row is truncate-end', async () => {
    for (const view of allViews) {
      for (const maxRows of [1, 2, 3]) {
        for (const r of bandRows(view, { maxRows }).rows) expect(r.wrap).toBe('truncate-end')
      }
    }
  })
})

describe('RULES', () => {
  test('names the reply shapes', async () => {
    for (const s of ['{"ok":true}', '{"skip":true}', '"count"', '"last"', '40 words', 'not English']) {
      expect(RULES).toContain(s)
    }
  })

  test('tells the model to skip shell commands', async () => {
    expect(RULES).toContain('shell command')
    expect(RULES).toMatch(/shell command[^\n]*\{"skip":true\}/)
    expect(RULES).toContain('git commit -m')
  })
})
