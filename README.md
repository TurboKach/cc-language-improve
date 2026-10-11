# language-improve

A Claude Code plugin (a "mod") that checks the English of your prompt while you write it. After a short pause, Haiku looks at the draft, and a line above the prompt shows the corrected sentence and a short reason, before you send the prompt:

```
✎ English · I want you to check my text before I send it  +1 more
  want + object · verb form · -ing after a preposition
```

Changed words are coloured and bold. When the draft has no errors the line reads `✓ English · no errors`. Nothing is saved; this version is live only.

## Requirements

- Claude Code 2.1.287 or newer, in the terminal or the Code tab of the Desktop app (mods draw only there). Built and tested on 2.1.296. Check with `claude --version`.
- A Claude plan or API key: each check is one Haiku call on your session's credentials (see [Cost](#cost)).
- Nothing else: no Node, no build step, no dependencies.

## Install

1. Install it from GitHub. At the prompt of a terminal session, type:
   ```
   /plugin install language-improve --marketplace TurboKach/cc-language-improve
   ```
   Answer `y` to add the marketplace, then pick the user scope. Or do the same from a shell, then start a new session:
   ```
   claude plugin marketplace add TurboKach/cc-language-improve
   claude plugin install language-improve@cc-language-improve --scope user
   ```
   Or install from a folder: clone this repository, then use the absolute path of the clone in the same commands in place of `TurboKach/cc-language-improve`, for example `/path/to/cc-language-improve`.
2. If you loaded an earlier copy through `CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`, remove that path first, and restart sessions that were open; otherwise both copies run.
3. Check that it loaded: run `/plugin` in Claude Code. A dim line under the tabs reads `1 mod active · language-improve` (the count includes your other mods). Press Esc to go back.

A GitHub install is a copy in Claude Code's plugin cache. To get a newer version, run `claude plugin update language-improve@cc-language-improve`, then `/reload-plugins` or start a new session. A folder install reads the folder itself: after you edit it, run `/reload-plugins`.

## Use

Type or dictate a prompt as usual and pause. For example, type:

```
I want that you checks my text before I sending it
```

About 1.5 s after you stop, the line above the prompt shows:

```
✎ English · I want you to check my text before I send it
  'that you checks' → 'you to check' · 'sending' → 'send'
```

Fix the text yourself or send it as it is; the line never changes your prompt. It clears or updates when you edit the flagged sentence.

## Turn it off

- **Off and on:** `/plugin disable language-improve@cc-language-improve`, and `/plugin enable language-improve@cc-language-improve` to turn it back on. Each takes effect when you close the `/plugin` menu, without a restart.
- **For good:** `/plugin uninstall language-improve@cc-language-improve`.
- **For one session:** start Claude Code with `--safe-mode`. This also turns off your other customizations.

The mod saves nothing, so there is nothing to clean up.

## How it works

- **Change detection.** Two triggers share one code path. The `prompt.edit` hook fires on each edit in the prompt box. A 500 ms poll of the draft catches changes that do not fire `prompt.edit` (history recall, draft restore, `$.prompt.fill`, and possibly voice dictation).
- **Pause.** 1.5 s after the last change, the draft is sent to Haiku (`$.model.complete`, on the session's credentials). A change while the call is in flight aborts it; an answer for an older draft is dropped.
- **Answer.** The model returns the erroneous sentence nearest the end of the draft, its correction and a reason; `+N more` shows how many other sentences have errors. It reports real errors only (grammar, wrong word, spelling) and ignores code, paths, quoted text, URLs, chat-style capitalisation, missing final punctuation, and dictation fillers or restarts. Text that is not English is skipped.
- **Band.** The result is drawn in the `AbovePrompt` band in the look of the built-in you-should-know band: a blank row above, a `✎` (or `✓`) glyph in the theme's `suggestion` colour, a dim `English · ` tag, then the text, with the reason indented under it. It yields to a survey, and keeps other mods' band content. The blank row is dropped first when the band has little room, then the reason row; with one row of room (`maxRows: 1`) the line and the reason share a row. Every row is cut at the terminal width.
- **Fast send.** If you press Enter before the pause ends, the sent text is checked at once and shown as `English · sent · …` (or `✓ English · sent · no errors`) until your next edit. Only your own Enter counts; task notifications, scheduled triggers, peers and plugins that submit prompts do not touch the checker. The check never delays your prompt.

## Skipped drafts (no model call)

- Fewer than 3 words.
- Starts with `/` (command) or `!` (a pasted or recalled shell line).
- Backtick-fenced code blocks (```` ``` ````) are removed before sending (`~~~` fences are not); the prose around them is still checked, and the 3-word rule applies to what remains.
- Mostly code without fences (more than about 30% of non-space characters are code-like symbols).
- Longer than 4,000 characters: only the last 4,000 are sent, cut at a sentence start.

Typed shell mode is not skipped by a rule: when you type `!`, Claude Code switches the box to shell mode and the `!` is not in the draft text that mods see, and no documented API exposes the mode. Instead the system prompt tells Haiku to reply `{"skip":true}` when the text is a shell command (`echo ...`, `git commit -m "..."`, `ls -la`), so no band shows. Those drafts still cost one call per pause. A correction that was showing before you turned the draft into a shell command stays until an edit removes the flagged sentence.

## Cost

At most one Haiku call per 1.5 s pause, plus one per fast send, billed to your plan or API key. A call is short (a small system prompt, your draft, a one-sentence reply). Aborted calls (you kept typing) still bill their input tokens.

## Known limits

- Voice dictation: whether built-in voice mode fires `prompt.edit` is unconfirmed. The 500 ms poll should catch it either way; this is the one path to check by hand with your dictation tool.
- No inline marks in the draft. No API paints the draft from a timer without moving the cursor, so the correction is shown above the prompt instead.
- One sentence at a time: the one nearest the end of the draft, plus a count of the rest.
- Shell commands typed in `!` mode are recognised by the model, not by a rule. A command with unusual prose may occasionally be checked; an ordinary sentence that starts with a program name may occasionally be skipped.
- Each shown result belongs to the current draft: any edit that removes the flagged sentence clears it.
- A prompt you just sent is not checked again if you recall it straight away (Up on the empty box): its `sent` result stays, and if that check failed nothing shows. Typing any other text first resets this.
- Fast send uses the check of the draft you last paused on. If a history recall replaces the draft and you press Enter within half a second (before the poll sees the change), the `sent` line can belong to the earlier draft.

## Privacy

- Your drafts are sent to Haiku through Claude Code's own model call (`$.model.complete`), on the same credentials and provider as your normal prompts. This includes drafts you never send.
- The mod writes nothing to disk and keeps no history. The current result lives in session state only and is cleared on restart.
- It makes no other network requests and runs no processes.

## Troubleshooting

- **Nothing appears.**
  - Run `/plugin` and look for `language-improve` in the `mod active` line. If it is missing, check `claude --version` (2.1.287 or newer), and that `claude plugin list` shows `language-improve@cc-language-improve` as enabled.
  - Wait about 2 s after your last keystroke. Drafts under 3 words, commands (`/…`), shell commands and code are skipped on purpose.
  - The line hides while a survey or a question dialog is open, and comes back after it closes.
  - Start Claude Code with `--debug` and read the debug log for `language-improve` errors. A `--plugin-dir` session also prints a dim transcript line when a drawing is refused.
- **`claude plugin test` fails with "not run from this spelling".** `claude` is a shell function or alias in your shell; run `command claude plugin test .`.
- **The line shows something odd.** The model can be wrong. Report the draft and the line (see [Known limits](#known-limits)).

## Manual test checklist

Run this before a release, in a real terminal session with the mod loaded once: the installed copy, or `claude --plugin-dir .` with the installed copy disabled (see [Development](#development)). Only cases 5 and 6 send a prompt.

1. Type `I want that you checks my text before I sending it` and wait 2 s → a blank row, then a `✎ English · ` line with the corrected sentence (changed words green and bold) and, indented under it, a dim reason.
2. Add ` and also this` → the line updates or clears after the pause.
3. Clear the box, paste `The weather is nice today and I am happy.` → `✓ English · no errors`.
4. Clear, type `!` then `echo he go to school yesterday and me likes it` → no line (shell mode).
5. Clear the box and leave shell mode (Backspace on the empty box until the `❯` glyph is back), then type the sentence from case 1 and press Enter at once → `✎ English · sent · …` while Claude answers; the prompt is not delayed.
6. Submit `/help` → no line.
7. Type a few words, clear the box, then press Up until an earlier prompt with an error shows → it is checked after the pause (this change does not fire `prompt.edit`, so it tests the 500 ms poll).
8. Narrow the terminal to about 60 columns and repeat case 1 → both rows are cut with `…`, not wrapped, and the reason row keeps its 2-space indent (`✎ English · I want you to check my text before I send …`, then `  'want that you' → 'want you to' · 'checks' → 'check'…`).
9. Dictate a sentence with your voice tool → the line appears after the pause.

## Development

To run the folder as it is, without installing, start `claude --plugin-dir .` in it; edits to `hooks/` reload while the session is open. Disable the installed copy first (`/plugin disable language-improve@cc-language-improve`), or both copies load.

To release, raise `version` in `.claude-plugin/plugin.json` before you push. Users get the change with `claude plugin update` only when the version is new.

Layout:

```
.claude-plugin/plugin.json   manifest ("types": "./types/index.d.ts")
.claude-plugin/marketplace.json  makes this folder the `cc-language-improve` marketplace
hooks/hooks.json             { "modules": ["./register.js"] }
hooks/register.js            wiring only: session.start (poll), prompt.edit, prompt.submit, ui.render
hooks/checker.js             change detection, debounce, cache, abort, stale drop, sent mode
hooks/lib.js                 pure helpers: skip rules, system prompt, reply parser, word diff, band rows
types/index.d.ts             PluginState['language-improve'] = { view: View | null }
tests/*.test.ts              lib, checker (fakes) and register (real hooks through the test kit)
```

File suffix scheme: the plugin modules are `.js` files with JSDoc types, imported with explicit `.js` specifiers (`import { createChecker } from './checker.js'`), and the tests are `*.test.ts` that import the same `.js` files (`../hooks/lib.js`). `claude plugin validate --strict` and `claude plugin test` accept this. A hooks module has no Node and no timer globals; use `$.clock`.

The checker takes its effects as dependencies (`read`, `after`, `complete`, `setView`), built in `session.start` from closures that write each `$` call in full on that hook's `$` (a bare method reference or a stored `$` does not load). The test kit cannot fire `prompt.edit`, so `tests/checker.test.ts` drives the checker directly with fakes, and `tests/register.test.ts` drives the real hooks through `$.session.start`, `mock.clock` and `$.ui.mount`.

Tuning constants: the pause `DEBOUNCE_MS` (1500) and call timeout `TIMEOUT_MS` (10000) in `hooks/checker.js`; the model alias `'haiku'` in the same file; the poll interval (500 ms) in `hooks/register.js`; the input cap `MAX_CHARS` (4000) in `hooks/lib.js`.

Run the checks:

```
claude plugin validate --strict .
claude plugin test .
```

If `claude` is a shell function or alias in your shell (it breaks the `plugin` subcommand), run `command claude plugin test .` and `command claude plugin validate --strict .`.

`.claude-plugin/types/` (the engine's type file for your build) and the root `tsconfig.json` are generated when Claude Code loads the plugin and are git-ignored. There is no `tsc` step; `claude plugin validate --strict` is the static check.
