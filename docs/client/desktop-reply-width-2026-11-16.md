# Desktop reply reading width

Desktop main-chat run replies have a `Widen reply` control beside their elapsed
time. It lets one reply use the available chat width; `Restore width` returns
that reply to the normal reading column. Text size stays unchanged. Existing
table scrolling and the separate table reader remain available for content that
is wider than the chat area.

The control is offered only when the chat area has useful extra space. Opening
a workbench or resizing the window can hide the control and restore the normal
column temporarily; widening the area restores the remembered choice. New
replies start at the normal width. Choices survive virtual scrolling and
conversation switches in this App window, and reset on reload.

This first version applies to main run-reply cards in desktop main chat. It
does not add controls to iOS or Android, mobile or iPad browsers, ADHD panes,
side conversations, scoped/background reports, or user messages.

## Ownership and layout

- `reply-width.ts` holds bounded, memory-only view state keyed by host, paired
  device, conversation and message. It changes no message or persisted setting.
- `Workspace` supplies a stable `ReplyWidthContext` only to the eligible main
  timeline. Its existing virtualizer viewport observer supplies the available
  width; no ancestor size container changes existing table `cqw` calculations.
- `RunPresentation` observes only its own width choice. After a toggle it hands
  the new row height to the existing virtualizer before paint. Virtual-row
  transforms, history anchors, tail following and content memoization retain
  their existing owners. There is no row-width animation.
- The icon, localized accessible name, pressed state and theme tokens make the
  same control usable by pointer and keyboard. The active surface follows the
  selected accent rather than using a fixed black fill.

CLI impact: not applicable. This is a local App reading-layout preference;
Host execution, transport, permissions and command-line output are unchanged.

## Verification

Focused coverage is in `client/e2e/reply-width.spec.ts`,
`client/e2e/reply-width-scope.spec.ts` and `tests/client-reply-width.test.ts`. It checks individual width changes, retained
state, viewport and workbench boundaries, streaming/history behavior,
keyboard focus, table readers, platform exclusions and localized appearances.
Related regressions are `markdown-tables`, `message-reading`,
`message-following`, `message-actions-hover`, `run-scopes` and `background-run`.

Validation uses the repository's unchanged lock files. Browser and synthetic
platform coverage does not establish installed macOS/Windows or physical mobile
device acceptance. This change does not publish or install an App.

Source verification completed with the unchanged lock files: 109 unit checks
and 65 Chromium UI cases passed, including frame-by-frame widening/restoring,
separate host/device/conversation views, mobile exclusions, existing table
readers, streaming and reading anchors. Host and client builds, client type
checking and translation validation passed. The width-change probe exposed a
stale virtual-row height; click-time measurement and bounded post-observer
follow-up measurement prevent gaps or overlap when a table toolbar changes
height after the width change. These are source-browser checks, not installed
App acceptance.

Additional shared-card regression checks found two existing Claude desktop/phone
stop-confirmation test failures in `run-presentation.spec.ts`. Both also fail at
the same assertion on the unchanged `3a653acf3fc7a2968c0e72d3ea32e4d4352c403c`
client build, without this control. This width change does not resolve or claim
acceptance of that separate stop-confirmation path.
