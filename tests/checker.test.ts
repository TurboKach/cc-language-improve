import { describe, expect, test } from 'claude-code/testing'
import { createChecker } from '../hooks/checker.js'

const A = 'I want that you checks my text.'
const B = 'She go to school every day.'
const ORIGINAL_A = 'I want that you checks my text.'
const fixReply = (original = ORIGINAL_A, corrected = 'I want you to check my text.') =>
  JSON.stringify({ count: 1, last: { original, corrected, why: 'verb form' } })
const FIX_A = { original: ORIGINAL_A, corrected: 'I want you to check my text.', why: 'verb form', more: 0 }

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// A checker over a hand-written clock, model and draft. `complete` calls stay
// pending until a test answers them; `advance` fires due timers and awaits
// the promises their callbacks return.
const setup = () => {
  const s: any = { readText: '', reads: 0, now: 0, views: [] as any[], calls: [] as any[], timers: [] as any[], gate: null }
  const deps = {
    read: async () => {
      s.reads++
      if (s.gate) await s.gate
      return { text: s.readText }
    },
    after: (ms: number, fn: () => Promise<void>) => {
      const timer = { at: s.now + ms, fn, cancelled: false, fired: false, cancel: () => void (timer.cancelled = true) }
      s.timers.push(timer)
      return timer
    },
    complete: (request: any, { signal }: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => s.calls.push({ request, signal, resolve, reject })),
    setView: (view: any) => void s.views.push(view),
  }
  s.checker = createChecker(deps)
  s.advance = async (ms: number) => {
    s.now += ms
    for (;;) {
      const due = s.timers.filter((t: any) => !t.cancelled && !t.fired && t.at <= s.now).sort((a: any, b: any) => a.at - b.at)
      if (due.length === 0) return
      due[0].fired = true
      await due[0].fn()
    }
  }
  s.pending = () => s.timers.filter((t: any) => !t.cancelled && !t.fired).length
  s.answer = (i: number, text: string) => s.calls[i].resolve({ isAnswered: true, text, usage: {} })
  s.fail = (i: number, reason = 'api-error') => s.calls[i].resolve({ isAnswered: false, reason })
  s.last = () => s.views[s.views.length - 1]
  // Starts a call for `text` by the timer path and leaves it pending.
  s.startDraftCall = async (text: string) => {
    s.readText = text
    await s.checker.poke(text)
    const p = s.advance(1500)
    await flush()
    return { p }
  }
  return s
}

describe('debounce and change detection', () => {
  test('one model call 1.5 s after the last change, with the Haiku request', async () => {
    const s = setup()
    s.readText = A
    await s.checker.poke(A)
    await s.advance(1499)
    expect(s.calls).toHaveLength(0)
    const p = s.advance(1)
    await flush()
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].request.model).toBe('haiku')
    expect(s.calls[0].request.prompt).toBe(A)
    expect(s.calls[0].request.timeoutMs).toBe(10000)
    expect(typeof s.calls[0].request.system).toBe('string')
    expect(s.calls[0].signal.aborted).toBe(false)
    s.answer(0, fixReply())
    await p
    expect(s.last()).toEqual({ kind: 'fix', source: 'draft', ...FIX_A })
  })

  test('a change inside the window restarts the timer: no call', async () => {
    const s = setup()
    await s.checker.poke(A)
    await s.advance(1000)
    s.readText = A + ' Please'
    await s.checker.poke(A + ' Please')
    await s.advance(1000)
    expect(s.calls).toHaveLength(0)
    expect(s.pending()).toBe(1)
    const p = s.advance(500)
    await flush()
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].request.prompt).toBe(A + ' Please')
    s.answer(0, '{"ok":true}')
    await p
  })

  test('poke with unchanged text does nothing', async () => {
    const s = setup()
    await s.checker.poke(A)
    const timers = s.timers.length
    await s.checker.poke(A)
    expect(s.timers).toHaveLength(timers)
    expect(s.timers[0].cancelled).toBe(false)
  })

  test('poke(text) uses the given text without calling read; poke() reads', async () => {
    const s = setup()
    await s.checker.poke(A)
    expect(s.reads).toBe(0)
    s.readText = B
    await s.checker.poke()
    expect(s.reads).toBe(1)
    expect(s.timers).toHaveLength(2)
    expect(s.timers[0].cancelled).toBe(true)
  })

  test('the timer callback returns a promise', async () => {
    const s = setup()
    s.readText = 'two words'
    await s.checker.poke('two words')
    const result = s.timers[0].fn()
    expect(typeof result.then).toBe('function')
    await result
  })

  test('an unchanged draft after a check reuses the cache', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, fixReply())
    await p
    expect(s.views).toHaveLength(1)
    await s.checker.poke(B) // different draft: view cleared
    expect(s.last()).toBeNull()
    s.readText = A
    await s.checker.poke(A)
    await s.advance(1500)
    expect(s.calls).toHaveLength(1)
    expect(s.last()).toEqual({ kind: 'fix', source: 'draft', ...FIX_A })
  })
})

describe('in-flight calls and stale answers', () => {
  test('a change during a call aborts it; a late answer is not shown', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    await s.checker.poke(A + ' Thanks')
    expect(s.calls[0].signal.aborted).toBe(true)
    s.calls[0].resolve({ isAnswered: false, reason: 'aborted' })
    await p
    expect(s.views).toHaveLength(0)
    // even an answered reply that raced the abort is dropped
    s.answer(0, fixReply())
    await flush()
    expect(s.views).toHaveLength(0)
  })

  test('a non-aborted answer for a superseded draft is dropped (request-id guard)', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    await s.checker.poke(B)
    s.answer(0, fixReply())
    await p
    expect(s.views).toHaveLength(0)
  })

  test('an answer is dropped when the draft read at answer time differs', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.readText = B // changed without a poke noticing
    s.answer(0, fixReply())
    await p
    expect(s.views).toHaveLength(0)
  })

  test('a call is made after a dropped answer: the checker keeps working', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    await s.checker.poke(B)
    s.answer(0, fixReply())
    await p
    s.readText = B
    const p2 = s.advance(1500)
    await flush()
    expect(s.calls).toHaveLength(2)
    s.answer(1, fixReply('She go to school every day.', 'She goes to school every day.'))
    await p2
    expect(s.last().corrected).toBe('She goes to school every day.')
  })
})

describe('skip rules and failures', () => {
  test('skip-rule drafts make no call', async () => {
    const s = setup()
    for (const text of ['two words', '/help me with this now', '!ls -la /tmp/some/dir']) {
      s.readText = text
      await s.checker.poke(text)
      await s.advance(1500)
    }
    expect(s.calls).toHaveLength(0)
    expect(s.views).toHaveLength(0)
  })

  test('isAnswered: false shows nothing and the next change is checked', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.fail(0)
    await p
    expect(s.views).toHaveLength(0)
    const { p: p2 } = await s.startDraftCall(B)
    expect(s.calls).toHaveLength(2)
    s.answer(1, fixReply('She go to school every day.', 'She goes to school every day.'))
    await p2
    expect(s.last().kind).toBe('fix')
  })

  test('a rejected complete shows nothing and the next change is checked', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.calls[0].reject(new Error('model blocked'))
    await p
    expect(s.views).toHaveLength(0)
    const { p: p2 } = await s.startDraftCall(B)
    expect(s.calls).toHaveLength(2)
    s.answer(1, '{"ok":true}')
    await p2
    expect(s.last()).toEqual({ kind: 'ok', source: 'draft' })
  })

  test('a malformed reply shows nothing and the next change is checked', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, '{"count":1,"last":{"original":"I want')
    await p
    expect(s.views).toHaveLength(0)
    const { p: p2 } = await s.startDraftCall(B)
    expect(s.calls).toHaveLength(2)
    s.answer(1, '{"ok":true}')
    await p2
    expect(s.last()).toEqual({ kind: 'ok', source: 'draft' })
  })

  test('a skip reply shows nothing', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, '{"skip":true}')
    await p
    expect(s.views).toHaveLength(0)
  })
})

describe('view clear rules', () => {
  const withFix = async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, fixReply())
    await p
    expect(s.views).toHaveLength(1)
    return s
  }

  test('a draft fix is kept while its original is still in the draft', async () => {
    const s = await withFix()
    await s.checker.poke(`  ${A.replace(' ', '\n')} Thanks a lot`) // whitespace differs, original still there
    expect(s.views).toHaveLength(1)
  })

  test('a draft fix is cleared when its original is no longer in the draft', async () => {
    const s = await withFix()
    await s.checker.poke('I want that you check my text')
    expect(s.views).toHaveLength(2)
    expect(s.last()).toBeNull()
  })

  test('a draft fix is cleared when the edit wraps its sentence in a code fence', async () => {
    const s = await withFix()
    await s.checker.poke(`Look at this\n\`\`\`\n${A}\n\`\`\``)
    expect(s.last()).toBeNull()
  })

  test('a draft fix is cleared when the draft becomes a skipped one', async () => {
    const s = await withFix()
    await s.checker.poke(`\`\`\`\n${A}\n\`\`\``)
    expect(s.last()).toBeNull()
  })

  test('a draft fix is cleared when its original survives only inside a longer word', async () => {
    const s = setup()
    const { p } = await s.startDraftCall('the cat sit on the mat')
    s.answer(0, fixReply('he cat', 'the cat'))
    await p
    expect(s.views).toHaveLength(0) // "he cat" is not a whole-word run of the sent text
  })

  test('an ok view is cleared on any change', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, '{"ok":true}')
    await p
    expect(s.last()).toEqual({ kind: 'ok', source: 'draft' })
    await s.checker.poke(A + ' more')
    expect(s.last()).toBeNull()
  })

  test('emptying the draft clears a draft view and starts no timer', async () => {
    const s = await withFix()
    await s.checker.poke('')
    expect(s.last()).toBeNull()
    expect(s.pending()).toBe(0)
  })
})

describe('sent mode (the draft reads empty when the answer lands)', () => {
  test('submit with no cached result starts an immediate sent check and shows it', async () => {
    const s = setup()
    await s.checker.poke(A)
    const p = s.checker.submit(A)
    await flush()
    expect(s.pending()).toBe(0) // debounce timer cancelled
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].request.prompt).toBe(A)
    s.readText = ''
    s.answer(0, fixReply())
    await p
    expect(s.last()).toEqual({ kind: 'fix', source: 'sent', ...FIX_A })
  })

  test('a sent check of text that fails the skip rules makes no call', async () => {
    const s = setup()
    await s.checker.submit('/help')
    expect(s.calls).toHaveLength(0)
    expect(s.views).toHaveLength(0)
  })

  test('submit while a call for the same text is in flight keeps it and shows its answer as sent', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    const submitted = s.checker.submit(A)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].signal.aborted).toBe(false)
    s.readText = ''
    await s.checker.poke('') // the draft was cleared
    s.answer(0, fixReply())
    await p
    await submitted
    expect(s.calls).toHaveLength(1)
    expect(s.last()).toEqual({ kind: 'fix', source: 'sent', ...FIX_A })
  })

  test('submit matches the in-flight call by the submitted text as well as the last-seen draft', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.checker.submit(A) // e.text equal to the draft
    s.readText = ''
    s.answer(0, '{"ok":true}')
    await p
    expect(s.last()).toEqual({ kind: 'ok', source: 'sent' })
    const t = setup()
    const { p: q } = await t.startDraftCall(B)
    t.checker.submit(`${B} (expanded paste)`) // pre-submit last-seen text matches the call
    expect(t.calls[0].signal.aborted).toBe(false)
    t.readText = ''
    t.answer(0, '{"ok":true}')
    await q
    expect(t.last()).toEqual({ kind: 'ok', source: 'sent' })
  })

  test('submit while a call for other text is in flight aborts it', async () => {
    // A draft call always matches the last-seen draft, so "other text" arises
    // from a second quick send: the first sent call is still in flight.
    const s = setup()
    await s.checker.poke(A)
    const first = s.checker.submit(A)
    await s.checker.poke('') // the draft cleared; the sent call stays
    expect(s.calls[0].signal.aborted).toBe(false)
    const second = s.checker.submit('Totally different submitted text here.')
    await flush()
    expect(s.calls[0].signal.aborted).toBe(true)
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1].request.prompt).toBe('Totally different submitted text here.')
    s.answer(0, fixReply()) // late answer for the aborted call
    await first
    expect(s.views).toHaveLength(0)
    s.readText = ''
    s.answer(1, '{"ok":true}')
    await second
    expect(s.last()).toEqual({ kind: 'ok', source: 'sent' })
  })

  test('submit with a cached result shows it as sent with no new call', async () => {
    const s = setup()
    const { p: p } = await s.startDraftCall(A)
    s.answer(0, fixReply())
    await p
    s.readText = ''
    await s.checker.submit(A)
    expect(s.calls).toHaveLength(1)
    expect(s.last()).toEqual({ kind: 'fix', source: 'sent', ...FIX_A })
  })

  test('a poll that reads the submitted text after submit is not a change', async () => {
    const s = setup()
    await s.checker.poke(A)
    const p = s.checker.submit(`${A} [pasted text expanded]`)
    expect(s.calls).toHaveLength(1)
    for (const text of [A, `${A} [pasted text expanded]`]) {
      s.readText = text
      await s.checker.poke()
    }
    expect(s.pending()).toBe(0)
    expect(s.calls[0].signal.aborted).toBe(false)
    s.readText = ''
    await s.checker.poke() // cleared draft: still no timer, call kept
    expect(s.pending()).toBe(0)
    expect(s.calls[0].signal.aborted).toBe(false)
    s.answer(0, '{"ok":true}')
    await p
    expect(s.last()).toEqual({ kind: 'ok', source: 'sent' })
    // after the draft cleared, the old texts still are not a change
    s.readText = A
    await s.checker.poke()
    expect(s.pending()).toBe(0)
  })

  test('a sent answer is dropped if the draft read at answer time is other text', async () => {
    const s = setup()
    await s.checker.poke(A)
    const p = s.checker.submit(A)
    s.readText = 'Something else the owner typed already'
    s.answer(0, fixReply())
    await p
    expect(s.views).toHaveLength(0)
  })

  test('a timer callback past cancel() when submit lands starts no draft call', async () => {
    const s = setup()
    await s.checker.poke(A)
    let release: () => void = () => {}
    s.gate = new Promise<void>((resolve) => (release = resolve))
    s.readText = A
    const callback = s.advance(1500) // timer fired, awaiting its read
    await flush()
    expect(s.reads).toBe(1)
    const sent = s.checker.submit('/help') // skipped text: no sent call either
    s.gate = null
    release()
    await callback
    await sent
    expect(s.calls).toHaveLength(0)
  })

  test('a timer callback past cancel() leaves only the sent call alive', async () => {
    const s = setup()
    await s.checker.poke(A)
    let release: () => void = () => {}
    s.gate = new Promise<void>((resolve) => (release = resolve))
    s.readText = A
    const callback = s.advance(1500)
    await flush()
    const sent = s.checker.submit(A)
    s.gate = null
    release()
    await flush()
    expect(s.calls).toHaveLength(1)
    s.readText = ''
    s.answer(0, '{"ok":true}')
    await callback
    await sent
    expect(s.calls).toHaveLength(1)
    expect(s.last()).toEqual({ kind: 'ok', source: 'sent' })
  })

  test('the first other non-empty change after submit clears the sent view and checks the new draft', async () => {
    const s = setup()
    await s.checker.poke(A)
    const p = s.checker.submit(A)
    s.readText = ''
    s.answer(0, fixReply())
    await p
    expect(s.last().source).toBe('sent')
    await s.checker.poke('') // empty: the sent view stays
    expect(s.last().source).toBe('sent')
    s.readText = B
    await s.checker.poke()
    expect(s.last()).toBeNull()
    const q = s.advance(1500)
    await flush()
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1].request.prompt).toBe(B)
    s.answer(1, '{"ok":true}')
    await q
    expect(s.last()).toEqual({ kind: 'ok', source: 'draft' })
  })

  test('the first other non-empty change after submit aborts a sent call', async () => {
    const s = setup()
    await s.checker.poke(A)
    const p = s.checker.submit(A)
    s.readText = ''
    await s.checker.poke('') // empty: the sent call stays
    expect(s.calls[0].signal.aborted).toBe(false)
    await s.checker.poke(B)
    expect(s.calls[0].signal.aborted).toBe(true)
    s.answer(0, fixReply()) // late answer
    await p
    expect(s.views).toHaveLength(0)
  })
})

describe('submit clears the view for a new prompt', () => {
  test('a submit the skip rules reject clears a draft view', async () => {
    const s = setup()
    const { p } = await s.startDraftCall(A)
    s.answer(0, fixReply())
    await p
    expect(s.last()).not.toBeNull()
    await s.checker.submit('/help')
    expect(s.last()).toBeNull()
  })

  test('a short submit clears a sent view', async () => {
    const s = setup()
    await s.checker.poke(A)
    const q = s.checker.submit(A)
    s.answer(0, fixReply())
    await q
    expect(s.last().source).toBe('sent')
    await s.checker.submit('ok go')
    expect(s.last()).toBeNull()
  })

  test('a submit of other text clears the old sent view while its own check is pending', async () => {
    const s = setup()
    await s.checker.poke(A)
    const q = s.checker.submit(A)
    s.answer(0, fixReply())
    await q
    await s.checker.poke('') // the box reads empty; the sent view stays
    expect(s.last()).toMatchObject({ source: 'sent', original: ORIGINAL_A })
    const r = s.checker.submit(B)
    expect(s.last()).toBeNull()
    expect(s.calls).toHaveLength(2)
    s.answer(1, fixReply(B, 'She goes to school every day.'))
    await r
    expect(s.last()).toMatchObject({ kind: 'fix', source: 'sent', original: B })
  })
})

describe('stop', () => {
  const gated = () => {
    const s = setup()
    let release: () => void = () => {}
    s.gate = new Promise<void>((resolve) => (release = resolve))
    return { s, release }
  }

  test('a poke still awaiting read() when stop() lands arms no timer and calls nothing', async () => {
    const { s, release } = gated()
    s.readText = A
    const p = s.checker.poke()
    await flush()
    s.checker.stop()
    release()
    await p
    await flush()
    expect(s.timers).toHaveLength(0)
    await s.advance(5000)
    expect(s.calls).toHaveLength(0)
    expect(s.views).toHaveLength(0)
  })

  test('after stop(), poke, submit and answers do nothing', async () => {
    const s = setup()
    const { p } = await s.startDraftCall(A)
    s.checker.stop()
    await s.checker.poke(B)
    s.checker.submit(B) // not awaited: a pending model call would never settle
    await flush()
    s.answer(0, fixReply())
    await p
    await s.advance(5000)
    expect(s.timers.filter((t: any) => t.at > 1500)).toHaveLength(0)
    expect(s.calls).toHaveLength(1)
    expect(s.views).toHaveLength(0)
  })


  test('stop cancels the timer and aborts the live call', async () => {
    const s = setup()
    await s.checker.poke(A)
    s.checker.stop()
    expect(s.pending()).toBe(0)
    const t = setup()
    const { p: p } = await t.startDraftCall(A)
    t.checker.stop()
    expect(t.calls[0].signal.aborted).toBe(true)
    t.answer(0, fixReply())
    await p
    expect(t.views).toHaveLength(0)
  })
})
