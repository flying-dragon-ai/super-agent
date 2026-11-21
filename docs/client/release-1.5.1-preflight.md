# Open Super Agent 1.5.1 preflight

This release starts from published 1.5.0 source
`a3bb52d46bb3a850723d7c5513cc281d953b0133`. The reviewed candidate includes
ordinary Bot-to-Bot clarification handling, the simpler cross-host permission
checklist, older-message dates with local-midnight refresh, Google Play channel
policy, removal of the unused local-notifications plugin, and Android system-bar
compatibility. Claude stop semantics are unchanged; the regression now confirms
the existing stop dialog before asserting completion.

## Distribution and explicit scope

All newly built App and CLI artifacts use version **1.5.1** and one frozen source
commit. Android GitHub APK and Play AAB both reserve code **2026110415**; the
Play Console preflight found 2026110414 as its highest accepted bundle, also
active in internal and closed Alpha testing. iOS uses build **1**. Build the
two Android channels separately and retain their established updater and APK
installation policies; equal version/code does not mean identical bytes.

Owner amendment, 2026-11-18: "这次不要做了 等下次" refers specifically to the
Play DEX optimization / R8 follow-up. Keep `minifyEnabled false` for this
release. The reported 1% obfuscation warning and February 2027 deadline remain
open for the next version; no optimized-package regression or resolved-warning
claim is made. The system-bar changes already merged in PR #45 remain in scope.

Excalidraw, Vditor, Baoyu Design/PPT, runtime and ordinary library versions are
not changed by this preflight. Complete the listed-integrations check and
shipped-dependency advisory review before freeze. Do not expand dependency
scope without the required owner decision.

The fresh review found Electron 45.3.4 available, including earlier certificate,
Chromium and V8 fixes after the pinned 45.3.0. After this was reported, the owner
selected "这次保留，下一版处理" on 2026-11-18. Retain 45.3.0 for this release and
carry that desktop security-patch review into the next cycle. This is an explicit
deferral, not a claim that the old browser runtime has no outstanding risks.

## Validation and publication boundaries

Run release source/native gates and affected permission, attachment, date,
notification and layout checks. Validate both signed Android channel artifacts,
including native update/install restrictions and retained Host pairing. Record
older-Android system-bar coverage separately from current-API emulator evidence.
Removing an unused notification plugin is not proof of live FCM/APNs delivery.

Verify source bindings, final signatures, unpacked artifact privacy and downloaded
bytes for every published asset. Build and verify the standalone Host from the
same source: ordinary Bot clarification behavior affects the Host/CLI, while
permission controls and timestamp presentation are App-only changes. No schema
or communication-protocol migration is included.

Publish one English download page with platform compatibility updater channels,
the actual iOS App Store and TestFlight availability, and the matching CLI archive.
Synchronize the official homepage after publication. Store upload, review,
testing availability and physical-device acceptance are separate states. This
preflight is not a publication or installed-App acceptance receipt.
