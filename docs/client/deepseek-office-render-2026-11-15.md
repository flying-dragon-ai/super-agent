# DeepSeek Office rendering on macOS

An Office preview could wait until the six-hour turn cap even after the PPTX
had been created successfully. The native LibreOffice Kit's default font scan
entered Microsoft Office's protected cloud-font cache. macOS awaited an
other-App-data permission decision. Kit's conversion deadline aborted, but its
cleanup awaited termination of a worker blocked in synchronous filesystem I/O.
The pending tool did not return until the six-hour turn cancellation. Native
cancellation released the tool reader, but the blocked worker remained alive.

The macOS private Harness home now uses explicit local font roots for the
standard `office-kit` provider: system fonts, installed user fonts and macOS
MobileAsset fonts. This avoids the implicit Office cloud-cache scan and the optional Word, Excel
and PowerPoint bundled-font scans. Fonts available only in those Office
locations can use the renderer's normal fallbacks; explicitly configured font roots remain user-owned.

`deepseek-office-fonts.ts` reads the installed CLI's boot-free
`--profile web --dump-config` output after composing the private home. It parses
YAML without evaluating `!!js` and retains the effective provider settings,
including custom limits, output location and loader expressions. Only missing
`fontDirectories` receives a default. The appended patch does not replace
provider identity, permissions, `inject`, or `disabled` state. Disabled/replaced
providers, explicit roots, runtime-computed configs and YAML references are
left unchanged. Unsupported/failed inspection retains existing behavior and
emits a sanitized diagnostic, never the config or subprocess output. The dump
has a fifteen-second deadline and a two-MiB output cap.

The change applies to both desktop-managed and standalone CLI DeepSeek hosts
on macOS. Windows/Linux do not inspect or change their Office settings. Mobile
clients use the connected host's behavior; their UI and native code are
unchanged. Other engines, global CLI files, user-supplied profile settings and credentials
are unchanged. The CLI may refresh its generated profile template during the
dump, just as during ordinary startup. General turn/inactivity budgets are
unchanged. This is a narrow mitigation
for implicit discovery, not an upstream worker-cancellation repair. Custom
protected font paths can still require a permission decision.

A separate macOS foreground-call watchdog covers `office_render`,
`office_convert` and `office_recalculate`. Its default is ten minutes; known
custom conversion/queue settings raise it to at least twice the configured
conversion deadline times one plus the queue batches. It never reduces a larger
calculated allowance. An unsupported/failed config dump uses the ten-minute
fallback. Explicit opaque/custom providers or runtime-computed budgets keep the
existing turn limit rather than guessing their behavior. `/timeout off` disables
this watchdog as well. Ordinary tools and background jobs retain their budgets.

App tool-approval waits are excluded from the Office deadline; the timer
resumes after the response, while the existing whole-turn cap still applies.
Timers belong to an active native turn and call ID. A result or settled turn
clears them; late events from an old turn cannot arm a timer against the next
request. Expiry requests cancellation through the existing exact prompt owner,
never a session-wide stop, and reports an engine timeout. Shared Chinese/English feedback identifies the
Office wait and directs the user to check the Mac permission prompt or deliver
an already-created file; it does not suggest disabling all timeouts. It does not replay the
prompt, restart the Bot, or delete an already-generated file. If cancellation
cannot be confirmed, that existing error remains visible. Native Goal watcher
and opaque PTC `run_code` calls do not use this foreground watchdog. The default
font mitigation still applies to their standard provider; the watchdog is not a
claim of bounded cancellation for every custom or indirect Office operation.

## Verification

- The original eight-slide file passed ZIP integrity checks and rendered all
  pages using explicit local roots; an unchanged default-font probe reproduced
  the blocked directory scan. Only disposable diagnostic processes were stopped.
- A real authenticated DeepSeek model, through the built Open Super Agent Host and
  adapter in isolated state, called `office_render` on an eight-slide synthetic
  Chinese/English presentation. The native tool returned success in about
  two to three seconds across three runs; whole turns completed in about ten
  to fourteen seconds.
- Focused tests cover composed settings, loader-expression preservation,
  custom/disabled/opaque configs, malformed YAML, private-home rebuilds,
  sanitized failures and platform isolation, plus the existing Harness
  lifecycle, protocol, tool and cancellation suites. Fake-clock regressions
  also cover Office hangs, unrelated activity, result/turn cleanup, old events,
  timeout opt-out, custom budgets and other long-running tools. Shared error
  renderer tests cover the Office-specific recovery guidance in both languages.
- Six isolated configuration dumps started concurrently, all producing the
  font patch and expected watchdog budget within the inspection deadline.
- This is source and isolated real-engine evidence. No release, installed-App
  replacement, phone acceptance or mutation of the original Bot occurred.
