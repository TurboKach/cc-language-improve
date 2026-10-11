// Wiring only: the checker's logic is in checker.js, the text helpers in lib.js.
// Every `$` call is written in full on the hook's own `$` (a bare method
// reference or a stored `$` does not load), so the checker is built inside
// `session.start` from closures over that hook's `$`.
import { createChecker } from './checker.js'
import { bandRows } from './lib.js'

/** @type {import('claude-code').Register} */
export const register = (on) => {
  let checker = null
  let poll = null

  on('session.start', async ($, e, next) => {
    // Fires again on enable, respawn and reload: drop the previous run first.
    if (checker !== null) checker.stop()
    if (poll !== null) poll.cancel()
    checker = null
    poll = null
    await $.state.set({ plugin: 'language-improve', key: 'view' }, null)

    const mine = createChecker({
      read: () => $.prompt.read(),
      after: (ms, fn) => $.clock.after(ms, fn),
      complete: (request, options) => $.model.complete(request, options),
      setView: (view) => $.state.set({ plugin: 'language-improve', key: 'view' }, view),
    })
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
    if (!view || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const layout = bandRows(view, { maxRows: e.props.maxRows })
    if (layout.rows.length === 0) return next(e) // no room for our rows
    const rows = layout.rows.map((row) =>
      Text({
        wrap: row.wrap,
        children: row.segments.map((segment) => Text({ ...segment.style, children: segment.text })),
      }),
    )
    const band = Box({ flexDirection: 'column', marginTop: layout.gap ? 1 : 0, children: rows })
    return Box({ flexDirection: 'column', children: [band, await next(e)] })
  })
}
