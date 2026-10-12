// Wiring only: the checker's logic is in checker.js, the text helpers in lib.js.
// Every `$` call is written in full on the hook's own `$` (a bare method
// reference or a stored `$` does not load), so the checker is built inside
// `session.start` from closures over that hook's `$`.
import { createChecker } from './checker.js'
import { KINDS, bandRows } from './lib.js'

/** @type {import('claude-code').Register} */
export const register = (on) => {
  let checker = null
  let poll = null

  // Keeps the known kind slugs of a stored list, in order, once each.
  const knownKinds = (list) => {
    const slugs = Array.isArray(list) ? list : []
    return slugs.filter((slug, i) => KINDS.some((k) => k.slug === slug) && slugs.indexOf(slug) === i)
  }

  // The stored list with one kind added or removed, known kinds only.
  const withKind = (list, slug, isMuted) =>
    isMuted ? knownKinds([...knownKinds(list), slug]) : knownKinds(list).filter((s) => s !== slug)

  on('session.start', async ($, e, next) => {
    // Fires again on enable, respawn and reload: drop the previous run first.
    if (checker !== null) checker.stop()
    if (poll !== null) poll.cancel()
    checker = null
    poll = null
    await $.state.set({ plugin: 'language-improve', key: 'view' }, null)
    const stored = knownKinds(await $.store.get('muted'))
    await $.command.register({
      name: 'language-improve',
      description: 'Lists the muted English-error kinds, with a button to unmute each.',
      immediate: true,
    })
    await $.state.set({ plugin: 'language-improve', key: 'muted' }, stored)

    const mine = createChecker({
      read: () => $.prompt.read(),
      after: (ms, fn) => $.clock.after(ms, fn),
      complete: (request, options) => $.model.complete(request, options),
      // A new view starts on page 1.
      setView: async (view) => {
        await $.state.set({ plugin: 'language-improve', key: 'page' }, 0)
        await $.state.set({ plugin: 'language-improve', key: 'view' }, view)
      },
    })
    mine.setMuted(stored)
    checker = mine
    // The poll catches drafts that bypass `prompt.edit` (history recall, fill,
    // draft restore, dictation).
    if (e.isInteractive) poll = $.clock.every(500, () => mine.poke())
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    if (checker !== null) checker.poke(r.text) // not awaited
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (checker !== null && e.origin.kind === 'composer') checker.submit(e.text) // not awaited
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: view } = await $.state.get({ plugin: 'language-improve', key: 'view' })
    const { value: muted = [] } = await $.state.get({ plugin: 'language-improve', key: 'muted' })
    const { value: page = 0 } = await $.state.get({ plugin: 'language-improve', key: 'page' })
    if (!view || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const layout = bandRows(view, { maxRows: e.props.maxRows, bodyColumns: e.props.bodyColumns, muted, page })
    if (layout.rows.length === 0) return next(e) // no room for our rows

    // The page moves from the page shown, wrapping; read again at the press.
    const turnPage = async (step) => {
      const { value: now = 0 } = await $.state.get({ plugin: 'language-improve', key: 'page' })
      const shown = Math.min(Math.max(now, 0), layout.pages - 1)
      await $.state.set({ plugin: 'language-improve', key: 'page' }, (shown + step + layout.pages) % layout.pages)
    }
    // Adds the kind to the stored list, so a mute from another session survives.
    const mute = async (slug) => {
      const merged = withKind(await $.store.get('muted'), slug, true)
      await $.store.set('muted', merged)
      await $.state.set({ plugin: 'language-improve', key: 'muted' }, merged)
      if (checker !== null) checker.setMuted(merged)
      $.ui.toast(`Muted ${KINDS.find((k) => k.slug === slug).label} · /language-improve to unmute`)
    }
    const press = (key) => {
      if (key === 'page:next') return () => turnPage(1)
      if (key === 'page:back') return () => turnPage(-1)
      return () => mute(key.slice('mute:'.length))
    }

    const rows = layout.rows.map((row) => {
      if (!row.actions) {
        return Text({
          wrap: row.wrap,
          children: row.segments.map((segment) => Text({ ...segment.style, children: segment.text })),
        })
      }
      const gap = () => Text({ children: '  ' })
      const items = [
        ...(row.pageText ? [Text({ dimColor: true, children: row.pageText })] : []),
        ...row.actions.map((action) =>
          Button({ key: action.key, hotkey: action.hotkey, label: action.label, plain: true, onPress: press(action.key) }),
        ),
        ...(row.hint ? [Text({ dimColor: true, children: row.hint })] : []),
      ]
      return Box({ flexDirection: 'row', children: [gap(), ...items.flatMap((item, i) => (i === 0 ? [item] : [gap(), item]))] })
    })
    const band = Box({ flexDirection: 'column', marginTop: layout.gap ? 1 : 0, children: rows })
    return Box({ flexDirection: 'column', children: [band, await next(e)] })
  })

  on('command.run', { command: 'language-improve' }, async ($) => {
    const { value: muted = [] } = await $.state.get({ plugin: 'language-improve', key: 'muted' })
    await $.ui.open({
      id: 'muted',
      title: 'Muted English errors',
      focus: true,
      closeOnEscape: true,
      // The heading row and the list (or the empty line). Only an inline pane takes this;
      // a pane docked beside the transcript keeps the full height whatever is asked.
      rows: 1 + Math.max(muted.length, 1),
    })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'muted' }, async ($, e) => {
    const { value: muted = [] } = await $.state.get({ plugin: 'language-improve', key: 'muted' })
    const { Box, Button, Text } = $.ui.resolve(e)
    // The pane's title is not drawn while it is the only pane open, so it carries its own heading.
    const heading = Text({ bold: true, children: 'Muted English errors' })
    if (muted.length === 0) {
      return Box({
        flexDirection: 'column',
        children: [heading, Text({ children: 'Nothing is muted. Focus the band (ctrl+x tab) and press a mute key.' })],
      })
    }
    // Removes the kind from the stored list, so a mute from another session survives.
    const unmute = async (slug) => {
      const merged = withKind(await $.store.get('muted'), slug, false)
      await $.store.set('muted', merged)
      await $.state.set({ plugin: 'language-improve', key: 'muted' }, merged)
      if (checker !== null) checker.setMuted(merged)
    }
    return Box({
      flexDirection: 'column',
      children: [
        heading,
        ...muted.map((slug, i) =>
          Button({
            key: `unmute:${slug}`,
            hotkey: 'asdfghjklzxc'[i],
            label: `unmute ${KINDS.find((k) => k.slug === slug).label}`,
            plain: true,
            onPress: () => unmute(slug),
          }),
        ),
      ],
    })
  })
}
