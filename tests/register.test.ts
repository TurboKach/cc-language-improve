import { describe, expect, mock, test } from 'claude-code/testing'

// These tests drive the loaded plugin through the engine's own `$`: a stubbed
// `session.start` raises the plugin's hook (which builds the checker), the
// mock clock runs its 500 ms poll and 1.5 s debounce, and `ui.mount` draws the
// AbovePrompt band. The kit cannot fire `prompt.edit`, so the poll is the
// trigger here; the edit and submit hooks' "never awaited" rule is checked at
// code review and in the real client.

const DRAFT = 'I want that you checks my text.'
const FIX = JSON.stringify({
  count: 1,
  last: { original: DRAFT, corrected: 'I want you to check my text.', why: 'want + object · verb form' },
})
const MORE = JSON.stringify({
  count: 3,
  last: { original: DRAFT, corrected: 'I want you to check my text.', why: 'want + object · verb form' },
})
const OK = JSON.stringify({ ok: true })

const mountTarget = (props: Record<string, unknown> = {}) =>
  ({
    plugin: 'language-improve',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    viewport: { columns: 80, rows: 24 },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns: 75,
      scroll: { offset: 0, bodyRows: 3 },
      view: {},
      ...props,
    },
  }) as const

// Registers every stub before the first `$` call, then starts the session.
const boot = async ($: any, on: any, { isInteractive = true, reply = FIX } = {}) => {
  const clock = mock.clock(on)
  const world = { draft: '', reply, requests: [] as any[], submits: [] as any[] }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: world.draft, cursor: world.draft.length } }))
  on('model.complete', (_$: any, e: any) => {
    world.requests.push(e)
    return { value: { isAnswered: true, text: world.reply, usage: {} } }
  })
  on('prompt.submit', (_$: any, e: any) => {
    world.submits.push(e)
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, (_$: any, e: any) => _$.ui.resolve(e).Text({ children: 'OTHER' }))
  await $.session.start({ surface: 'terminal', isInteractive, cwd: '/tmp' })
  return { clock, world }
}

// A draft the poll sees (500 ms), then the 1.5 s pause.
const typeAndWait = async (clock: any, world: any, draft: string) => {
  world.draft = draft
  await clock.advance(500)
  await clock.advance(1500)
}

// Our rows are the Texts with wrap 'truncate-end'; their nested Texts are the styled segments.
const rowsOf = async (ui: any) => (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.wrap === 'truncate-end')
const segmentsOf = async (ui: any) => (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.wrap === undefined && t.text !== 'OTHER')

describe('AbovePrompt band', () => {
  test('yields to other mods with no view', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(mountTarget())
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'no errors' })).toBeUndefined()
  })

  test('shows the corrected sentence with styled changes and a dim reason after a poll-detected draft and 1.5 s', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0].model).toBe('haiku')
    expect(world.requests[0].prompt).toBe(DRAFT)

    const ui = await $.ui.mount(mountTarget())
    const rows = (await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER')
    expect(rows.map((r: any) => r.text)).toEqual([
      '✎ English · I want you to check my text.',
      '  want + object · verb form',
    ])
    const segments = await segmentsOf(ui)
    const added = segments.filter((s: any) => s.props.color === 'diffAddedWord')
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((s: any) => s.props.bold === true)).toBe(true)
    expect(added.map((s: any) => s.text).join(' ')).toContain('check')
    expect(segments.some((s: any) => s.text === 'want + object · verb form' && s.props.dimColor === true)).toBe(true)
    expect(segments.some((s: any) => s.text.includes('more'))).toBe(false)
  })

  test('shows "+N more" when more sentences have errors', async ($, on) => {
    const { clock, world } = await boot($, on, { reply: MORE })
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget())
    const segments = await segmentsOf(ui)
    expect(segments.some((s: any) => s.text === '  +2 more' && s.props.dimColor === true)).toBe(true)
  })

  test('shows "✓ no errors" for an ok reply', async ($, on) => {
    const { clock, world } = await boot($, on, { reply: OK })
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget())
    const segments = await segmentsOf(ui)
    expect(segments.map((s: any) => [s.text, s.props.color, s.props.dimColor])).toEqual([
      ['✓ ', 'suggestion', undefined],
      ['English · ', undefined, true],
      ['no errors', undefined, true],
    ])
    expect((await rowsOf(ui)).filter((r: any) => r.text === '✓ English · no errors')).toHaveLength(1)
  })

  test('puts both parts on one row at maxRows: 1', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget({ maxRows: 1 }))
    const rows = (await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER')
    expect(rows.map((r: any) => r.text)).toEqual(['✎ English · I want you to check my text. · want + object · verb form'])
  })

  test('emits none of its rows at maxRows: 0 and yields the band', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget({ maxRows: 0 }))
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
    expect((await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER')).toHaveLength(0)
  })

  test('never emits more rows than maxRows', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    for (const maxRows of [1, 2, 3]) {
      const ui = await $.ui.mount(mountTarget({ maxRows }))
      const rows = (await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER').length
      // Our Box is the one that carries marginTop.
      const gap = (await ui.findAll({ type: 'Box' })).some((b: any) => b.props.marginTop === 1) ? 1 : 0
      expect(rows + gap).toBeLessThanOrEqual(maxRows)
      await ui.unmount()
    }
  })

  test('keeps other mods\' band content next to its rows', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget())
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ English · I want you to check my text.' })).toBeDefined()
  })

  test('yields while a survey holds the band', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget({ hasSurvey: true }))
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
  })
})

describe('submit', () => {
  test('a composer submit shows the sent view', async ($, on) => {
    const { clock, world } = await boot($, on)
    world.draft = DRAFT
    await clock.advance(500) // the poll sees the draft; the pause has not ended
    await $.prompt.submit({ text: DRAFT, origin: { kind: 'composer' }, wait: false })
    world.draft = ''
    await clock.settle()
    expect(world.submits).toHaveLength(1)
    expect(world.requests).toHaveLength(1)
    const ui = await $.ui.mount(mountTarget())
    expect(await ui.find({ type: 'Text', text: '✎ English · sent · I want you to check my text.' })).toBeDefined()
  })

  test('a task-notification submit leaves the checker untouched', async ($, on) => {
    const { clock, world } = await boot($, on)
    world.draft = DRAFT
    await clock.advance(500)
    await $.prompt.submit({ text: 'background task finished', origin: { kind: 'task-notification' }, wait: false })
    await clock.settle()
    expect(world.requests).toHaveLength(0)
    const before = await $.ui.mount(mountTarget())
    expect(await before.find({ type: 'Text', text: '✎' })).toBeUndefined()
    await before.unmount()

    await clock.advance(1500) // the pending draft check still fires
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0].prompt).toBe(DRAFT)
    const ui = await $.ui.mount(mountTarget())
    expect(await ui.find({ type: 'Text', text: '✎ English · I want you to check my text.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sent ·' })).toBeUndefined()
  })
})

describe('poll', () => {
  test('no poll when the session is not interactive', async ($, on) => {
    const { clock, world } = await boot($, on, { isInteractive: false })
    await typeAndWait(clock, world, DRAFT)
    await clock.advance(5000)
    expect(world.requests).toHaveLength(0)
  })

  test('a second session.start does not double the checks', async ($, on) => {
    const { clock, world } = await boot($, on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp' })
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests).toHaveLength(1)
  })
})
