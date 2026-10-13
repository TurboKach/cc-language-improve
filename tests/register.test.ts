import { describe, expect, mock, test } from 'claude-code/testing'

// These tests drive the loaded plugin through the engine's own `$`: a stubbed
// `session.start` raises the plugin's hook (which builds the checker), the
// mock clock runs its 500 ms poll and 1.5 s debounce, and `ui.mount` draws the
// AbovePrompt band. The kit cannot fire `prompt.edit`, so the poll is the
// trigger here; the edit and submit hooks' "never awaited" rule is checked at
// code review and in the real client.

const DRAFT = 'I want that you checks my text.'
const ERROR = {
  original: DRAFT,
  corrected: 'I want you to check my text.',
  changes: [
    { kind: 'word-choice', why: 'want + object' },
    { kind: 'verb-form', why: 'verb form' },
  ],
}
const FIX = JSON.stringify({ errors: [ERROR] })
const MORE_DRAFT = `${DRAFT} She go home. He have a dog.`
const MORE = JSON.stringify({
  errors: [
    ERROR,
    { original: 'She go home.', corrected: 'She goes home.', changes: [{ kind: 'agreement', why: 'agreement' }] },
    { original: 'He have a dog.', corrected: 'He has a dog.', changes: [{ kind: 'agreement', why: 'agreement' }] },
  ],
})
const MANY_DRAFT = `${DRAFT} She go home. I dont know it. He have a dog.`
const MANY = JSON.stringify({
  errors: [
    ERROR,
    { original: 'She go home.', corrected: 'She goes home.', changes: [{ kind: 'agreement', why: 'agreement' }] },
    { original: 'I dont know it.', corrected: "I don't know it.", changes: [{ kind: 'apostrophe', why: 'missing apostrophe' }] },
    { original: 'He have a dog.', corrected: 'He has a dog.', changes: [{ kind: 'agreement', why: 'agreement' }] },
  ],
})
const OK = JSON.stringify({ ok: true })

// Wide enough for the whole action row.
const WIDE = 200
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
// The band starts expanded (`expanded` stored as true) so most tests see the reasons and the mute buttons; `null` stores nothing.
const boot = async ($: any, on: any, { isInteractive = true, reply = FIX, stored = [] as unknown, expanded = true as boolean | null } = {}) => {
  const clock = mock.clock(on)
  // The plugin's store, in memory; a test edits `world.store` to play "another session".
  const world = {
    draft: '',
    reply,
    requests: [] as any[],
    submits: [] as any[],
    toasts: [] as string[],
    commands: [] as any[],
    opens: [] as any[],
    store: new Map<string, unknown>(stored === undefined ? [] : [['muted', stored]]),
  }
  if (expanded !== null) world.store.set('expanded', expanded)
  on('store.get', (_$: any, e: any) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    world.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('ui.toast', (_$: any, e: any) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$: any, e: any) => {
    world.commands.push(e)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$: any, e: any) => {
    world.opens.push(e)
    return { value: { isPlaced: true } }
  })
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
// The styled segments of our rows; a Button's label Text is not one.
const segmentsOf = async (ui: any) => {
  const labels = (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)
  return (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.wrap === undefined && t.text !== 'OTHER' && !labels.includes(t.text))
}
// A Button's label Text, with its color.
const labelColor = async (ui: any, label: string) =>
  (await ui.findAll({ type: 'Text' })).find((t: any) => t.text === label && t.props.wrap === undefined)?.props.color

describe('AbovePrompt band', () => {
  test('yields to other mods with no view', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(mountTarget())
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'no errors' })).toBeUndefined()
  })

  test('shows the fixed text, a reason row per group and colored mute buttons after a poll-detected draft and 1.5 s', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0].model).toBe('haiku')
    expect(world.requests[0].prompt).toBe(DRAFT)

    const ui = await $.ui.mount(mountTarget())
    const rows = (await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER')
    expect(rows.map((r: any) => r.text)).toEqual([
      '✎ English · I want you to check my text.',
      '  grammar: verb form',
      '  wording: want + object',
    ])
    const segments = await segmentsOf(ui)
    // The two fixes are of different groups and the reply names no words: bold, no color.
    const changed = segments.filter((s: any) => s.props.bold === true)
    expect(changed.map((s: any) => s.text).join(' ')).toContain('check')
    expect(changed.every((s: any) => s.props.color === undefined)).toBe(true)
    expect(segments.some((s: any) => s.text === 'grammar: verb form' && s.props.color === 'warning')).toBe(true)
    expect(segments.some((s: any) => s.text === 'wording: want + object' && s.props.color === 'autoAccept')).toBe(true)
    expect(await labelColor(ui, 'mute word choice')).toBe('autoAccept')
    expect(await labelColor(ui, 'mute verb forms')).toBe('warning')
    expect(segments.some((s: any) => s.text.includes('more'))).toBe(false)
  })

  test('a changed word is in the color of the group of the change that wrote it', async ($, on) => {
    const named = {
      ...ERROR,
      changes: [
        { kind: 'word-choice', words: 'you to', why: 'want + object' },
        { kind: 'verb-form', words: 'check', why: 'verb form' },
      ],
    }
    const { clock, world } = await boot($, on, { reply: JSON.stringify({ errors: [named] }) })
    await typeAndWait(clock, world, DRAFT)
    const segments = await segmentsOf(await $.ui.mount(mountTarget()))
    expect(segments.filter((s: any) => s.props.bold === true).map((s: any) => [s.text, s.props.color])).toEqual([
      ['to', 'autoAccept'],
      ['check', 'warning'],
    ])
  })

  test('a band taller than maxRows is drawn whole, for the engine to scroll', async ($, on) => {
    const { clock, world } = await boot($, on, { reply: MORE })
    await typeAndWait(clock, world, MORE_DRAFT)
    for (const maxRows of [3, 2, 1]) {
      const ui = await $.ui.mount(mountTarget({ maxRows }))
      expect((await rowsOf(ui)).map((r: any) => r.text).filter((t: string) => t !== 'OTHER')).toEqual([
        '✎ English · I want you to check my text. She goes home. He has a dog.',
        '  grammar: verb form · agreement',
        '  wording: want + object',
      ])
      expect(await ui.find({ key: 'mute:agreement' })).toBeDefined()
      expect((await ui.findAll({ type: 'Box' })).some((b: any) => b.props.marginTop === 1)).toBe(false)
      expect((await segmentsOf(ui)).some((s: any) => s.text.includes('more'))).toBe(false)
      await ui.unmount()
    }
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

  test('emits none of its rows at maxRows: 0 and yields the band', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget({ maxRows: 0 }))
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
    expect((await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER')).toHaveLength(0)
  })

  test('the gap row shows only when it and every row fit in maxRows', async ($, on) => {
    const { clock, world } = await boot($, on, { reply: MANY })
    await typeAndWait(clock, world, MANY_DRAFT)
    // Text row, 3 reasons rows (grammar, wording, punctuation), the action row.
    for (const maxRows of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const ui = await $.ui.mount(mountTarget({ maxRows, bodyColumns: WIDE }))
      const actionRows = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.flexDirection === 'row').length
      const rows = (await rowsOf(ui)).filter((r: any) => r.text !== 'OTHER').length + actionRows
      const gap = (await ui.findAll({ type: 'Box' })).some((b: any) => b.props.marginTop === 1)
      expect(rows).toBe(5)
      expect(gap).toBe(maxRows >= 6)
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

describe('stacked band and mute', () => {
  const bandTexts = async (ui: any) =>
    (await rowsOf(ui)).map((r: any) => r.text).filter((t: string) => t !== 'OTHER')
  const manyBand = async ($: any, on: any, options = {}) => {
    const booted = await boot($, on, { reply: MANY, ...options })
    await typeAndWait(booted.clock, booted.world, MANY_DRAFT)
    return booted
  }

  test('4 errors at maxRows 10: one text, a reasons row per group, the mute buttons and the hint', async ($, on) => {
    await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    expect(await bandTexts(ui)).toEqual([
      "✎ English · I want you to check my text. She goes home. I don't know it. He has a dog.",
      '  grammar: verb form · agreement',
      '  wording: want + object',
      '  punctuation: missing apostrophe',
    ])
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'OTHER' })).toBeDefined()
    const hotkeys = async (key: string) => (await ui.find({ key }))?.props.hotkey
    expect(await hotkeys('mute:word-choice')).toBe('a')
    expect(await hotkeys('mute:verb-form')).toBe('s')
    expect(await hotkeys('mute:agreement')).toBe('d')
    expect(await hotkeys('mute:apostrophe')).toBe('f')
    expect(await labelColor(ui, 'mute word choice')).toBe('autoAccept')
    expect(await labelColor(ui, 'mute verb forms')).toBe('warning')
    expect(await labelColor(ui, 'mute agreement')).toBe('warning')
    expect(await labelColor(ui, 'mute apostrophes')).toBe('claude')
    expect((await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.props.key).startsWith('page'))).toHaveLength(0)
  })

  test('the Buttons are plain and use letter hotkeys only', async ($, on) => {
    await manyBand($, on)
    for (const maxRows of [3, 5, 7, 10]) {
      const ui = await $.ui.mount(mountTarget({ maxRows }))
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.length).toBeGreaterThan(0)
      for (const b of buttons) {
        expect(b.props.plain).toBe(true)
        expect(b.props.hotkey).toMatch(/^[a-z]$/)
      }
      await ui.unmount()
    }
  })

  test('an edit that keeps every error redraws the same rows with the new text', async ($, on) => {
    const { clock, world } = await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    const before = await bandTexts(ui)
    world.draft = `${MANY_DRAFT} Fine.`
    await clock.advance(500) // the poll sees the edit; the new check has not started
    expect(world.requests).toHaveLength(1)
    const after = await bandTexts(ui)
    expect(after[0]).toBe(`${before[0]} Fine.`)
    expect(after.slice(1)).toEqual(before.slice(1))
    expect(await ui.find({ key: 'mute:apostrophe' })).toBeDefined()
  })

  test('muting a kind redraws without it, stores it, toasts, and tells the model', async ($, on) => {
    const { clock, world } = await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'mute:apostrophe' })
    expect(await bandTexts(ui)).toEqual([
      "✎ English · I want you to check my text. She goes home. I dont know it. He has a dog.",
      '  grammar: verb form · agreement',
      '  wording: want + object',
    ])
    expect(await ui.find({ key: 'mute:apostrophe' })).toBeUndefined()
    expect(world.store.get('muted')).toEqual(['apostrophe'])
    expect(world.toasts).toEqual(['Muted apostrophes · /language-improve to unmute'])

    expect(world.requests).toHaveLength(1)
    expect(world.requests[0].system).not.toContain('Do not report')
    await typeAndWait(clock, world, `${MANY_DRAFT} Fine.`)
    expect(world.requests).toHaveLength(2)
    expect(world.requests[1].system).toContain('Do not report or fix these kinds: apostrophes.')
  })

  test('a mute merges with what another session stored', async ($, on) => {
    const { clock, world } = await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    world.store.set('muted', ['comma']) // another session mutes commas
    await ui.press({ key: 'mute:apostrophe' })
    expect(world.store.get('muted')).toEqual(['comma', 'apostrophe'])
    await typeAndWait(clock, world, `${MANY_DRAFT} Fine.`)
    expect(world.requests.at(-1).system).toContain('Do not report or fix these kinds: apostrophes, commas.')
  })

  test('muting every visible kind reads "no errors"', async ($, on) => {
    const { clock, world } = await boot($, on)
    await typeAndWait(clock, world, DRAFT)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'mute:word-choice' })
    expect(await bandTexts(ui)).toEqual(['✎ English · I want you to check my text.', '  grammar: verb form'])
    await ui.press({ key: 'mute:verb-form' })
    expect(await bandTexts(ui)).toEqual(['✓ English · no errors'])
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(world.toasts).toHaveLength(2)
  })

  test('session.start loads the stored list, drops unknown slugs and tells the checker', async ($, on) => {
    const { clock, world } = await boot($, on, { stored: ['verb-form', 'nope', 7, 'word-choice', 'verb-form'] })
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests[0].system).toContain('Do not report or fix these kinds: verb forms, word choice.')
    expect(world.requests[0].system).not.toContain('nope')
    const ui = await $.ui.mount(mountTarget())
    expect((await rowsOf(ui)).filter((r: any) => r.text === '✓ English · no errors')).toHaveLength(1)
  })

  test('a stored value that is not a list loads as nothing muted', async ($, on) => {
    const { clock, world } = await boot($, on, { stored: 'apostrophe' })
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests[0].system).not.toContain('Do not report')
  })

  test('a narrow band cuts mute buttons from the end and drops the hint first', async ($, on) => {
    await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: 60 }))
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    expect(await ui.find({ key: 'mute:word-choice' })).toBeDefined()
    expect(await ui.find({ key: 'mute:verb-form' })).toBeDefined()
    expect(await ui.find({ key: 'mute:agreement' })).toBeUndefined()
  })

  test('at 45 columns the cut buttons leave room for the hint, which is drawn', async ($, on) => {
    await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: 45 }))
    expect(await ui.find({ key: 'mute:word-choice' })).toBeDefined()
    expect(await ui.find({ key: 'mute:verb-form' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
  })

  test('with no room for even one mute button the band draws the toggle alone', async ($, on) => {
    await manyBand($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: 10 }))
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.props.key)).toEqual(['toggle'])
    expect((await bandTexts(ui)).length).toBeGreaterThan(1)
  })
})

describe('minimal and expanded', () => {
  const bandTexts = async (ui: any) => (await rowsOf(ui)).map((r: any) => r.text).filter((t: string) => t !== 'OTHER')
  const start = async ($: any, on: any, options = {}) => {
    const booted = await boot($, on, options)
    await typeAndWait(booted.clock, booted.world, DRAFT)
    return booted
  }

  test('a fresh session starts minimal: the fixed text and the toggle, no reasons, no mute Button', async ($, on) => {
    await start($, on, { expanded: null })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    expect(await bandTexts(ui)).toEqual(['✎ English · I want you to check my text.'])
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map((b: any) => [b.props.key, b.props.hotkey, b.props.plain])).toEqual([['toggle', 'm', true]])
    expect(await labelColor(ui, 'more')).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'more' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
  })

  test('pressing the toggle shows the reasons and the mute Buttons, and stores expanded: true', async ($, on) => {
    const { world } = await start($, on, { expanded: null })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'toggle' })
    expect(await bandTexts(ui)).toEqual(['✎ English · I want you to check my text.', '  grammar: verb form', '  wording: want + object'])
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.props.key)).toEqual(['toggle', 'mute:word-choice', 'mute:verb-form'])
    expect(await ui.find({ type: 'Text', text: 'less' })).toBeDefined()
    expect(world.store.get('expanded')).toBe(true)
  })

  test('a new session with expanded stored starts expanded', async ($, on) => {
    await start($, on, { expanded: true })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    expect((await bandTexts(ui)).length).toBe(3)
    expect(await ui.find({ key: 'mute:verb-form' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'less' })).toBeDefined()
  })

  test('a stored value that is not true starts minimal', async ($, on) => {
    await start($, on, { expanded: 'yes' as any })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    expect(await bandTexts(ui)).toHaveLength(1)
  })

  test('pressing less returns to minimal and stores false', async ($, on) => {
    const { world } = await start($, on)
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'toggle' })
    expect(await bandTexts(ui)).toEqual(['✎ English · I want you to check my text.'])
    expect(await ui.find({ key: 'mute:verb-form' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'more' })).toBeDefined()
    expect(world.store.get('expanded')).toBe(false)
  })

  test('the mode is remembered across drafts', async ($, on) => {
    const { clock, world } = await start($, on, { expanded: null })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'toggle' })
    await typeAndWait(clock, world, `${DRAFT} Fine.`)
    expect((await bandTexts(ui)).length).toBe(3)
  })

  test('muting works from the expanded view reached with the toggle', async ($, on) => {
    const { world } = await start($, on, { expanded: null })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: WIDE }))
    await ui.press({ key: 'toggle' })
    await ui.press({ key: 'mute:word-choice' })
    expect(world.store.get('muted')).toEqual(['word-choice'])
    expect(await bandTexts(ui)).toEqual(['✎ English · I want you to check my text.', '  grammar: verb form'])
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
  })

  test('minimal draws the toggle even at the width where no mute button fits', async ($, on) => {
    await start($, on, { expanded: null })
    const ui = await $.ui.mount(mountTarget({ maxRows: 10, bodyColumns: 12 }))
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.props.key)).toEqual(['toggle'])
  })
})

describe('/language-improve pane', () => {
  const paneTarget = () =>
    ({
      plugin: 'language-improve',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'muted',
      viewport: { columns: 80, rows: 24 },
      props: { title: 'Muted English errors', isFocused: true, bodyColumns: 70, placement: 'inline' },
    }) as any

  test('session.start registers the command as immediate', async ($, on) => {
    const { world } = await boot($, on)
    expect(world.commands).toHaveLength(1)
    expect(world.commands[0]).toMatchObject({ name: 'language-improve', immediate: true })
    expect(typeof world.commands[0].description).toBe('string')
  })

  test('running it opens the pane with focus, Escape-close and rows sized to the heading and list', async ($, on) => {
    const { world } = await boot($, on, { stored: ['apostrophe', 'comma'] })
    const result = await $.command.run({ command: 'language-improve' })
    expect(result.text).toBeUndefined()
    expect(world.opens).toHaveLength(1)
    expect(world.opens[0]).toMatchObject({ id: 'muted', focus: true, closeOnEscape: true, rows: 3 })
    expect(typeof world.opens[0].title).toBe('string')
  })

  test('with nothing muted the pane opens a heading and one line tall', async ($, on) => {
    const { world } = await boot($, on)
    await $.command.run({ command: 'language-improve' })
    expect(world.opens[0].rows).toBe(2)
  })

  test('the pane draws its own heading, as a single pane shows no title', async ($, on) => {
    await boot($, on, { stored: ['apostrophe'] })
    expect(await (await $.ui.mount(paneTarget())).find({ type: 'Text', text: 'Muted English errors' })).toBeDefined()
  })

  test('the empty pane draws the heading too', async ($, on) => {
    await boot($, on)
    expect(await (await $.ui.mount(paneTarget())).find({ type: 'Text', text: 'Muted English errors' })).toBeDefined()
  })

  test('two muted kinds show two unmute Buttons with letter hotkeys', async ($, on) => {
    await boot($, on, { stored: ['apostrophe', 'comma'] })
    const ui = await $.ui.mount(paneTarget())
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map((b: any) => [b.props.key, b.props.hotkey, b.props.plain, b.props.label])).toEqual([
      ['unmute:apostrophe', 'a', true, 'unmute apostrophes'],
      ['unmute:comma', 's', true, 'unmute commas'],
    ])
  })

  test('a press unmutes: state, store and the checker', async ($, on) => {
    const { clock, world } = await boot($, on, { stored: ['apostrophe', 'comma'] })
    const ui = await $.ui.mount(paneTarget())
    world.store.set('muted', ['apostrophe', 'comma', 'spelling']) // another session muted spelling
    await ui.press({ key: 'unmute:apostrophe' })
    expect(world.store.get('muted')).toEqual(['comma', 'spelling'])
    expect(await ui.find({ key: 'unmute:apostrophe' })).toBeUndefined()
    expect(await ui.find({ key: 'unmute:comma' })).toBeDefined()
    await typeAndWait(clock, world, DRAFT)
    expect(world.requests.at(-1).system).toContain('Do not report or fix these kinds: commas, spelling.')
  })

  test('unmuting the last kind shows the empty line', async ($, on) => {
    const { world } = await boot($, on, { stored: ['apostrophe'] })
    const ui = await $.ui.mount(paneTarget())
    await ui.press({ key: 'unmute:apostrophe' })
    expect(world.store.get('muted')).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Nothing is muted. Focus the band (ctrl+x tab), press m, then a mute key.' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test('with nothing muted the pane shows the empty line', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(paneTarget())
    expect(await ui.find({ type: 'Text', text: 'Nothing is muted. Focus the band (ctrl+x tab), press m, then a mute key.' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
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
