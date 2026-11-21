# PR integration review, 2026-11-20

Reviewed PRs #51, #52, #54, #55, #56, #59 and #60 against main
`62212ea992d0e5c94c8febe8ebc37d881331c591`. Review included an independent
FABLE5 pass, local integration, focused fixes and isolated runtime checks.
This is source integration, not a release or an installed-App update.

## Corrections made during review

- DeepSeek profiles use real private plugin copies so plugins resolve runtime
  packages as they do in native DSH, including plugins without declared peers.
  Preserve private bootstrap state when the shared web profile is absent.
  Mirror ownership, checked ancestors, staged atomic replacement and serialized
  preparation protect shared/external directories and interrupted copies.
- Combined folder ordering keeps its cache current while views are unmounted.
  Its manager edits the same local order as the list when only one of several
  configured Hosts is ready. The order belongs to this device; folder contents
  and pinning still belong to their original Hosts. No Hub/CLI API changed.
- Windows notification readiness distinguishes accepted confirmation delivery
  from an independently readable Enabled setting. A valid diagnostic reporting
  an unknown setting is shown as unverified. The confirmation text is neutral
  in both languages. The acceptance probe no longer registers the production
  AUMID before first-launch checks unless explicitly requested afterwards.
- Checkbox outlines have a fallback for engines without `color-mix()`.
- Test fixtures no longer kill real processes through synthetic child PIDs,
  omit the fullscreen query contract, or treat Unix-rooted paths as absolute
  Windows paths. Two pre-existing UI assertions were reproduced on base and
  updated to preserve meaningful geometry and reconnection checks.

Host-side DeepSeek changes also apply to the standalone CLI through its shared
adapter. Folder presentation, notification UI and checkbox styling do not add
CLI capabilities. No dependency, platform version or release metadata changed.

## Evidence and limits

- The initial integrated tree plus the fake-PID fixture correction passed all
  676 unit-test files: 8,944 tests; 17 tests skipped. Final repairs then passed
  219 focused unit tests and root/client builds. The full suite was not rerun
  after those focused repairs.
- Notification browser coverage passed 119 cases; the acceptance-script suite
  passed 10. Cross-host folder coverage passed six cases; phone/desktop checkbox
  checks passed two. A wider folder/mobile/ADHD run passed 82 of 84 cases;
  both failures reproduced on base and passed after correcting stale assertions.
  Screen settings passed 28 cases after correcting its fullscreen fixture.
- A real macOS Electron window and native transport paired two isolated real
  Hosts, reordered their folders, preserved order after reload, routed same-ID
  conversations to the correct Host, retained drafts and fitted a narrow window.
  Separate Electron fullscreen transitions and synthetic video decoding passed.
  These do not prove real remote capture/input or physical-phone behavior.
- Real DSH with synthetic homes and a local fake provider verified model/effort
  isolation, plugin resolution, legacy migration and cold starts. The built App
  plugin and both search-MCP paths loaded and registered. No paid-model or live
  search request was made; real model tool execution remains unverified.
- On a physical Windows 11 machine, notification component tests passed 27
  cases plus one read-only WinRT probe; installer-helper tests passed 30.
  The final profile-copy probe passed six NTFS/junction cases. Updater tests
  initially passed 34 of 35; the remaining test used Unix-only fixture paths.
  The fixture was corrected without changing production argument validation.
  All 35 updater cases then passed on Windows; the corrected config tests also
  passed five cases on macOS.
- Windows NSIS install/update/uninstall, production AUMID first registration,
  actual toast delivery and physical iOS/Android acceptance remain outstanding.
  No daily installation, Host or user data was modified by these checks.

## Issue accounting

| Issue | Result of this integration |
| --- | --- |
| #46 | Cross-host folder ordering implemented; runtime and browser checks above. |
| #47 | Model quota display is not implemented by these PRs. |
| #48 | Windows controlled-screen support has preparation and clearer unsupported messaging only. |
| #49 | Mobile screen viewing has preparation only. |
| #50 | Uninstall order, diagnostics and recovery improved; original report and full Windows installation flow remain unverified. Keep open. |
| #53 | Native rewind/fork alignment is not implemented by these PRs. |
| #57 | Configuration isolation is the first step; provider/model catalog and per-model effort selection remain. Keep open. |

Issue #58 (Pi) was excluded at the owner's request. Source merge or successful
component tests must not close unfinished feature work or stand in for package
acceptance. Windows uninstall's prior implementation already checked the App
before moving data; the reviewed change additionally closes it before stopping
the Host. The report's original failure has not been reproduced.
