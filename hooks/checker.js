// Change detection, debounce, cache, abort, stale drop and `sent` mode for the
// language-improve mod. No `$`, no timers, no Node: every effect comes in
// through `deps`.
import { containsWordRun, normalizeWhitespace, parseErrors, prepareDraft, systemPrompt } from './lib.js'

const DEBOUNCE_MS = 1500
const TIMEOUT_MS = 20000
const MAX_TOKENS = 2048

/**
 * deps:
 *   read()                     -> Promise<{ text }>          the current draft
 *   after(ms, fn)              -> { cancel() }               a cancellable timer
 *   complete(request, { signal }) -> Promise<result union>   the model call
 *   setView(view | null)                                      writes the shown view
 *
 * Returns `{ poke(text?), submit(text), setMuted(slugs), stop() }`; `poke` and
 * `submit` return promises that settle when the work they started is done
 * (callers need not await them). `setMuted` takes the muted kind slugs and
 * applies at once: the model is told to leave them out, and a cached result
 * made with another muted list is not reused.
 */
export const createChecker = ({ read, after, complete, setView }) => {
  let lastSeen = ''
  let submitted = new Set() // texts that are not a change after a submit
  let requestId = 0 // bumped on every change and submit; guards timer callbacks
  let timer = null
  let active = null // the one live model call: { draft, sentText, mode, muted, key, controller, done }
  let cache = null // one entry: { key, result }; key is the draft plus the muted list
  let muted = [] // muted kind slugs, sorted
  let view = null // the view last written through setView
  let stopped = false // set by stop(): no effect leaves this checker afterwards

  const show = (next) => {
    if (stopped) return
    view = next
    setView(next)
  }
  const clearView = () => {
    if (view !== null) show(null)
  }
  const cancelTimer = () => {
    if (timer !== null) timer.cancel()
    timer = null
  }
  const abortActive = () => {
    if (active === null) return
    active.controller.abort()
    active = null
  }

  const cacheKey = (draft, slugs) => `${draft}\n${slugs.join(',')}`

  const apply = (result, source) => {
    if (result === 'ok') show({ kind: 'ok', source })
    else if (result !== 'skip' && result !== null) show({ kind: 'fix', source, ...result })
  }

  const run = async (call) => {
    let reply
    try {
      reply = await complete(
        { model: 'haiku', system: systemPrompt(call.muted), prompt: call.sentText, timeoutMs: TIMEOUT_MS, maxTokens: MAX_TOKENS },
        { signal: call.controller.signal },
      )
    } catch {
      reply = null
    }
    if (active !== call) return // aborted or superseded
    if (reply === null || !reply.isAnswered) {
      active = null
      return
    }
    const result = parseErrors(reply.text, call.sentText)
    const { text: current } = await read()
    if (active !== call) return
    // A draft answer belongs to the draft it was asked about; a sent answer
    // stays valid while the draft is empty or one of the submitted texts.
    const fresh =
      call.mode === 'sent'
        ? normalizeWhitespace(current) === '' || submitted.has(current)
        : current === call.draft
    active = null
    if (!fresh) return
    if (result !== null) cache = { key: call.key, result }
    apply(result, call.mode)
  }

  const check = (draft, mode) => {
    if (stopped) return Promise.resolve()
    const sentText = prepareDraft(draft)
    if (sentText === null) return Promise.resolve()
    const key = cacheKey(draft, muted)
    if (cache !== null && cache.key === key) {
      apply(cache.result, mode)
      return Promise.resolve()
    }
    abortActive()
    const call = { draft, sentText, mode, muted, key, controller: new AbortController(), done: null }
    active = call
    call.done = run(call)
    return call.done
  }

  const startTimer = () => {
    const id = requestId
    timer = after(DEBOUNCE_MS, async () => {
      timer = null
      const { text } = await read()
      if (stopped || id !== requestId) return // stopped, or a change or submit landed while reading
      await check(text, 'draft')
    })
  }

  const onText = (text) => {
    if (stopped || text === lastSeen) return
    const empty = normalizeWhitespace(text) === ''
    if (!empty && submitted.has(text)) return
    lastSeen = text
    requestId++
    cancelTimer()

    if (empty) {
      // Empty draft: a sent view and a sent call are exempt.
      if (active !== null && active.mode === 'draft') abortActive()
      if (view !== null && view.source === 'draft') clearView()
      return
    }

    // The first other non-empty change returns to draft mode.
    submitted = new Set()
    abortActive()
    if (view !== null) {
      // Each error is kept only while its original is in the text that would
      // be sent now; a draft that is now skipped clears the view.
      const sentNow = prepareDraft(text)
      const kept =
        view.source === 'draft' && view.kind === 'fix' && sentNow !== null
          ? view.errors.filter((error) => containsWordRun(normalizeWhitespace(sentNow), error.original))
          : []
      if (kept.length === 0) clearView()
      else if (kept.length < view.errors.length) show({ ...view, errors: kept })
    }
    startTimer()
  }

  return {
    poke: async (text) => {
      onText(text === undefined ? (await read()).text : text)
    },

    submit: (text) => {
      if (stopped) return Promise.resolve()
      cancelTimer()
      requestId++
      // Whatever is shown belongs to an earlier text; the view after a submit
      // is the submitted text's result or nothing.
      clearView()
      if (prepareDraft(text) === null) {
        abortActive() // a call for the earlier text must not answer for this one
        return Promise.resolve()
      }
      const pre = lastSeen
      submitted.add(pre)
      submitted.add(text)

      let kept = null
      if (active !== null && (active.draft === pre || active.draft === text)) {
        active.mode = 'sent'
        kept = active
      } else {
        abortActive()
      }

      const hit = [text, pre].map((draft) => (cache !== null && cache.key === cacheKey(draft, muted) ? cache : null)).find(Boolean)
      if (hit) {
        apply(hit.result, 'sent')
        return kept ? kept.done : Promise.resolve()
      }
      return kept ? kept.done : check(text, 'sent')
    },

    setMuted: (slugs) => {
      muted = [...slugs].sort()
    },

    stop: () => {
      stopped = true
      cancelTimer()
      abortActive()
      requestId++
    },
  }
}
