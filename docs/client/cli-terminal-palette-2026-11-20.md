# CLI terminal palette refresh

The existing App CLI palette now follows a black console: neutral grey-white
prose, blue prompts and links, green agent labels, yellow warnings and red
errors. Code uses orange keywords, green strings, blue names, pale-yellow types
and purple constants. Bright text and semibold weight distinguish headings and
emphasis without changing the user's reading size. The sidebar shares the black
canvas, and selected rows use a blue highlight instead of a pale reverse bar.

`expressive-themes.css` owns the CLI colour tokens, including the miniature
settings preview. `cli-typography.css` assigns those colours to text and retains
the bundled JetBrains Mono / Sarasa Term SC font stack. Removing its duplicate
colour declarations prevents the preview and transcript from inheriting a
second palette. No font files or dependencies were changed.

All selectors remain scoped to the CLI palette or its decorative preview.
The theme stays dark-only and retains the saved mode for switching to other
palettes. Draft state, message handling, table sizing, mobile touch targets,
native input sizing and custom avatars/media are unchanged. The headless CLI
is not affected: this is App presentation, not an engine or terminal-output
change. Chart series keep their independent data-colour tokens.

## Verification

- Host build and client translation/type/build checks passed.
- WebKit `run-formatting` native/legacy theme parity passed, including all
  palettes in light/dark fixture modes.
- Chromium: 12 relevant cases passed across `cli-typography`, `palettes`,
  `theme-font-size` and the two chart-palette cases, covering 320/390/1360px,
  saved modes and sizes, drafts, controls, contrast and theme restoration.
- Initial runs exposed two stale test assumptions, also reproduced with the
  baseline styles. Alignment is now checked by rendered geometry instead of
  the `flex-start`/`flow-start` serialization. Chart fixtures enumerate supported
  modes rather than forcing the dark-only CLI palette into light mode. The
  three affected cases passed after those test corrections; no production
  layout or chart colours were changed to satisfy them.
- Fable's same-page stylesheet comparison found no geometry/type-size changes
  for CLI desktop/mobile, and no differences in other palettes outside the
  intentionally updated CLI preview. Sampled text contrast was at least 5.35:1.

Fable designed and implemented the CSS; the integrator independently reviewed
the diff and rendered desktop/mobile views. Synthetic browser fixtures are
not installed-App or physical-phone acceptance. This change does not publish a
release or update an installed App.
