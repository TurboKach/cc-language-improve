# language-improve

A Claude Code plugin (a "mod") that checks the English of your prompt while you write it. After a short pause, Haiku looks at the draft, and a band above the prompt lists the errors it found, each as a corrected sentence with a short reason, before you send the prompt:

```
✎ English · I want you to check my text before I send it
  want + object · verb form
  a: mute word choice  s: mute verb forms  ctrl+x tab
```

Changed words are coloured and bold. When the draft has no errors the line reads `✓ English · no errors`. You can mute a kind of error you do not want to see (for example missing apostrophes) and bring it back with `/language-improve`. The only thing the mod saves is the list of muted kinds.

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

About 1.5 s after you stop, the band above the prompt shows each erroneous sentence corrected, with the reasons under it. With a longer draft, for example:

```
I want that you checks my text. She go home. I dont know it. He have a dog.
```

the band shows:

```
✎ English · I want you to check my text.
  want + object · verb form
✎ She goes home.
  agreement
✎ I don't know it.
  missing apostrophe
  ‹ 1/2 ›  n: next  p: back  a: mute word choice  s: mute verb forms  d: mute agreement  f: mute apostrophes  ctrl+x tab
```

Fix the text yourself or send it as it is; the band never changes your prompt. It shows up to 8 errors, 3 for each page, in the order they appear in the draft. An edit that removes a flagged sentence drops that error; the others stay.

**Keys.** The keys work after you focus the band: press ctrl+x then tab, or click it. Esc gives the keys back to the prompt.

- `n` and `p` page forward and back (they wrap around). The `‹ 1/2 ›` text shows the page; it appears only when there is more than one.
- The letters on the mute buttons (`a s d f g h j k l`, in that order) mute one kind of error: it leaves the band at once and is no longer reported. A toast confirms it. A kind the model cannot name (`other`) has no mute button.
- The kinds are articles, prepositions, verb forms, agreement, word order, word choice, plural/singular, pronouns, apostrophes, commas, spelling and capitalization.

**Unmute.** Run `/language-improve` (it also works while Claude is answering). A pane lists the muted kinds, each with an `unmute` button and a letter key (`a s d f g h j k l z x c`). With nothing muted, it says so. Esc closes the pane. Mutes are saved, so they stay after a restart.

**Apostrophes.** The model labels each fix with a kind, and a label can be wrong. So when apostrophes are muted, the mod also checks the text itself: a word whose only change is apostrophes (`dont` → `don't`, `im` → `I'm`, `its` → `it's`) is left as you typed it, whatever the label says. If that was the whole error, the error is dropped.

## Turn it off

- **Off and on:** `/plugin disable language-improve@cc-language-improve`, and `/plugin enable language-improve@cc-language-improve` to turn it back on. Each takes effect when you close the `/plugin` menu, without a restart.
- **For good:** `/plugin uninstall language-improve@cc-language-improve`.
- **For one session:** start Claude Code with `--safe-mode`. This also turns off your other customizations.

The mod saves only the list of muted kinds (see [Privacy](#privacy)). To clear it, unmute each kind with `/language-improve`.

## How it works

- **Change detection.** Two triggers share one code path. The `prompt.edit` hook fires on each edit in the prompt box. A 500 ms poll of the draft catches changes that do not fire `prompt.edit` (history recall, draft restore, `$.prompt.fill`, and possibly voice dictation).
- **Pause.** 1.5 s after the last change, the draft is sent to Haiku (`$.model.complete`, on the session's credentials). A change while the call is in flight aborts it; an answer for an older draft is dropped.
- **Answer.** The model returns a list of up to 8 erroneous sentences, in the order they appear in the draft. Each has its correction and its changes, and each change has a kind (one of the 12 above) and a short reason. The mod checks every error on its own: it drops one whose quoted sentence is not in the draft, one that changes nothing, a repeat, and one with no valid change. It reports real errors only (grammar, wrong word, spelling) and ignores code, paths, quoted text, URLs, chat-style capitalisation, missing final punctuation, and dictation fillers or restarts. Text that is not English is skipped.
- **Muted kinds.** The system prompt tells the model not to report the muted kinds. The band also filters them when it draws, so a mute shows at once with no new model call. A muted kind is part of the cache key, so a mute or an unmute makes the next check ask again.
- **Band.** The result is drawn in the `AbovePrompt` band in the look of the built-in you-should-know band: a blank row above, then for each error a `✎` (or `✓`) glyph in the theme's `suggestion` colour and the corrected text (the dim `English · ` tag is on the first error of each page), with the reasons indented under it. Under the errors is one row of buttons: page text and `n`/`p`, the mute buttons for the kinds on this page, and a dim `ctrl+x tab` hint. It yields to a survey, and keeps other mods' band content. When the band has little room, it drops the blank row first, then shows fewer errors on a page (3, 2, then 1). With 2 rows of room (`maxRows: 2`) it shows the first error with `+N more` and its reasons, with no buttons; with one row (`maxRows: 1`) the line and the reasons share a row. On a narrow terminal the button row drops the hint first, then mute buttons from the end. Every row is cut at the terminal width.
- **Fast send.** If you press Enter before the pause ends, the sent text is checked at once and shown as `English · sent · …` (or `✓ English · sent · no errors`) until your next edit. Only your own Enter counts; task notifications, scheduled triggers, peers and plugins that submit prompts do not touch the checker. The check never delays your prompt.

## Skipped drafts (no model call)

- Fewer than 3 words.
- Starts with `/` (command) or `!` (a pasted or recalled shell line).
- Backtick-fenced code blocks (```` ``` ````) are removed before sending (`~~~` fences are not); the prose around them is still checked, and the 3-word rule applies to what remains.
- Mostly code without fences (more than about 30% of non-space characters are code-like symbols).
- Longer than 4,000 characters: only the last 4,000 are sent, cut at a sentence start.

Typed shell mode is not skipped by a rule: when you type `!`, Claude Code switches the box to shell mode and the `!` is not in the draft text that mods see, and no documented API exposes the mode. Instead the system prompt tells Haiku to reply `{"skip":true}` when the text is a shell command (`echo ...`, `git commit -m "..."`, `ls -la`), so no band shows. Those drafts still cost one call per pause. A correction that was showing before you turned the draft into a shell command stays until edits have removed every flagged sentence.

## Cost

At most one Haiku call per 1.5 s pause, plus one per fast send, billed to your plan or API key. A call is short (a small system prompt, your draft, and a reply with one short entry for each error, at most 8). Aborted calls (you kept typing) still bill their input tokens.

## Known limits

- Voice dictation: whether built-in voice mode fires `prompt.edit` is unconfirmed. The 500 ms poll should catch it either way; this is the one path to check by hand with your dictation tool.
- No inline marks in the draft. No API paints the draft from a timer without moving the cursor, so the correction is shown above the prompt instead.
- Up to 8 errors, 3 for each page. Past 8, the rest are not shown.
- The keys need the band in focus (ctrl+x tab or a click); a mod cannot bind a key inside the prompt box. Esc returns the keys to the prompt.
- Mute buttons are trimmed from the end on a narrow terminal, and a page shows at most 9.
- A mute from another open session reaches this one only after a restart. A mute never erases another session's mute.
- After an unmute, the kind shows again only after your next edit: the result on screen was made without it.
- The model labels each fix with a kind. A sentence with a muted fix and another fix may keep the muted fix's reason if the model labels it oddly. With apostrophes muted, the text check leaves apostrophe-only word changes alone, but a word fixed for both an apostrophe and capitals (`obrien` → `O'Brien`) is left as you typed it.
- Shell commands typed in `!` mode are recognised by the model, not by a rule. A command with unusual prose may occasionally be checked; an ordinary sentence that starts with a program name may occasionally be skipped.
- Each shown result belongs to the current draft: an edit that removes a flagged sentence drops that error, and when none are left the band clears.
- A prompt you just sent is not checked again if you recall it straight away (Up on the empty box): its `sent` result stays, and if that check failed nothing shows. Typing any other text first resets this.
- Fast send uses the check of the draft you last paused on. If a history recall replaces the draft and you press Enter within half a second (before the poll sees the change), the `sent` line can belong to the earlier draft.

## Privacy

- Your drafts are sent to Haiku through Claude Code's own model call (`$.model.complete`), on the same credentials and provider as your normal prompts. This includes drafts you never send.
- Your drafts and results are never saved and the mod keeps no history. The current result lives in session state only and is cleared on restart.
- The one thing the mod saves is the list of muted kinds (names such as `apostrophe`), in Claude Code's plugin store, so your mutes stay after a restart.
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

Run this before a release, in a real terminal session with the mod loaded once: the installed copy, or `claude --plugin-dir .` with the installed copy disabled (see [Development](#development)). Only cases 5 and 6 send a prompt. Cases 10-14 change your saved mutes: unmute everything at the end.

1. Type `I want that you checks my text before I sending it` and wait 2 s → a blank row, then a `✎ English · ` line with the corrected sentence (changed words green and bold) and, indented under it, a dim reason, then a row of mute buttons.
2. Add ` and also this` → the line updates or clears after the pause.
3. Clear the box, paste `The weather is nice today and I am happy.` → `✓ English · no errors`.
4. Clear, type `!` then `echo he go to school yesterday and me likes it` → no line (shell mode).
5. Clear the box and leave shell mode (Backspace on the empty box until the `❯` glyph is back), then type the sentence from case 1 and press Enter at once → `✎ English · sent · …` while Claude answers; the prompt is not delayed.
6. Submit `/help` → no line.
7. Type a few words, clear the box, then press Up until an earlier prompt with an error shows → it is checked after the pause (this change does not fire `prompt.edit`, so it tests the 500 ms poll).
8. Narrow the terminal to about 60 columns and repeat case 1 → both rows are cut with `…`, not wrapped, and the reason row keeps its 2-space indent (`✎ English · I want you to check my text before I send …`, then `  want + object · verb form`); the button row drops `ctrl+x tab`, then mute buttons from the end.
9. Dictate a sentence with your voice tool → the line appears after the pause.
10. Type `I want that you checks my text. She go home. I dont know it. He have a dog.` and wait 2 s → 3 stacked errors, `‹ 1/2 ›` and a row of mute buttons.
11. Press ctrl+x then tab, then `n` → page 2 (`‹ 2/2 ›`, one error); `n` again → page 1; `p` → page 2. Esc returns the keys to the prompt.
12. Focus the band and press the key of `mute apostrophes` → a toast reads `Muted apostrophes · /language-improve to unmute` and the `I don't know it.` error leaves the band.
13. Restart `claude`, type `i dont know where is the file` → no apostrophe fix, and the other errors still show.
14. Run `/language-improve` → the pane lists `unmute apostrophes`; press its key → `Nothing is muted. Focus the band (ctrl+x tab) and press a mute key.`; Esc closes the pane.

## Development

To run the folder as it is, without installing, start `claude --plugin-dir .` in it; edits to `hooks/` reload while the session is open. Disable the installed copy first (`/plugin disable language-improve@cc-language-improve`), or both copies load.

To release, raise `version` in `.claude-plugin/plugin.json` before you push. Users get the change with `claude plugin update` only when the version is new.

Layout:

```
.claude-plugin/plugin.json   manifest ("types": "./types/index.d.ts")
.claude-plugin/marketplace.json  makes this folder the `cc-language-improve` marketplace
hooks/hooks.json             { "modules": ["./register.js"] }
hooks/register.js            wiring only: session.start (poll, /language-improve command), prompt.edit, prompt.submit, command.run, ui.render (band and `muted` pane)
hooks/checker.js             change detection, debounce, cache (draft and muted kinds), abort, stale drop, sent mode, per-error keep rule
hooks/lib.js                 pure helpers: skip rules, kinds, system prompt, reply parser, muted filter, word diff, band rows
types/index.d.ts             PluginState['language-improve'] = { view: View | null; muted: string[]; page: number }
tests/*.test.ts              lib, checker (fakes) and register (real hooks through the test kit)
```

File suffix scheme: the plugin modules are `.js` files with JSDoc types, imported with explicit `.js` specifiers (`import { createChecker } from './checker.js'`), and the tests are `*.test.ts` that import the same `.js` files (`../hooks/lib.js`). `claude plugin validate --strict` and `claude plugin test` accept this. A hooks module has no Node and no timer globals; use `$.clock`.

The checker takes its effects as dependencies (`read`, `after`, `complete`, `setView`), built in `session.start` from closures that write each `$` call in full on that hook's `$` (a bare method reference or a stored `$` does not load). The test kit cannot fire `prompt.edit`, so `tests/checker.test.ts` drives the checker directly with fakes, and `tests/register.test.ts` drives the real hooks through `$.session.start`, `mock.clock` and `$.ui.mount`.

Tuning constants: the pause `DEBOUNCE_MS` (1500) and call timeout `TIMEOUT_MS` (20000) and reply cap `MAX_TOKENS` (2048) in `hooks/checker.js`; the model alias `'haiku'` in the same file; the poll interval (500 ms) in `hooks/register.js`; the input cap `MAX_CHARS` (4000) in `hooks/lib.js`.

Run the checks:

```
claude plugin validate --strict .
claude plugin test .
```

If `claude` is a shell function or alias in your shell (it breaks the `plugin` subcommand), run `command claude plugin test .` and `command claude plugin validate --strict .`.

`.claude-plugin/types/` (the engine's type file for your build) and the root `tsconfig.json` are generated when Claude Code loads the plugin and are git-ignored. There is no `tsc` step; `claude plugin validate --strict` is the static check.
