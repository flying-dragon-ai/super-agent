# Open Super Agent 1.5.0 preflight

This feature release starts from the published 1.4.2 baseline. It adds a
per-reply width toggle to desktop conversations and fixes the official Windows
DeepSeek Desktop launcher route so native tool pipes survive process startup.
The width toggle is limited to desktop main-chat replies; phone, tablet, ADHD
and side-conversation layouts retain their existing behavior.

## Source and review

- Desktop reading width: `833c390` with independent design and regression review.
- Windows DeepSeek Desktop: PR #37, merged as `ca02f771`; the Windows workflow
  coverage and route documentation follow in `cd3a453`.
- The Windows change uses the exact recognized vendor launcher and installed
  Electron runtime directly. Explicit custom launchers and other engine routes
  retain their established behavior. Discovery precedence is unchanged.
- The existing Claude stop-confirmation browser-test failures remain tracked
  separately in issue #38; this release does not change stop behavior.

## Dependency and platform scope

Excalidraw 0.18.1 and Vditor 4.0.1 match the stable upstream registry on
2026-11-16. Baoyu Design/PPT and adapted skills retain their verified pins.
Ordinary dependencies and the patched standalone Node 24.22.3 runtime are
unchanged. A fresh advisory review covers shipped dependencies before freeze;
newer Electron patches remain a separate next-cycle review, not an automatic
release upgrade.

The App and standalone CLI share version 1.5.0 and the frozen source. The width
control is presentation-only; Windows engine launch behavior also applies to
the standalone Host. iOS build 1 and Android version code 2026110412 belong to
this version. No mobile native dependency upgrade is included.

## Release verification boundary

Use a fresh isolated dependency installation, the full source/native release
gates and focused layout regressions. Verify signed final packages, renderer
inventories, privacy scans, CLI clean installation and existing-host upgrade,
then downloaded release bytes. Keep actual receipts in private release evidence.

The owner authorized Windows publication without waiting for lengthy Windows
native acceptance; record this as deferred, never passed. Simulator and emulator
evidence do not establish physical-device acceptance. TestFlight upload,
processing and external beta availability are separate states. This preflight
is not a claim that packages have been published or installed.

Publish a single English `v1.5.0` download page with macOS, Windows, Android and
CLI assets plus the public iOS TestFlight link, retaining platform compatibility
update channels. Do not update the owner's installed App as a release side effect.
