# Open Super Agent 1.4.2 preflight

The owner authorized an all-platform release with one canonical English download
page. Windows may publish after build, signature, package-content and privacy
verification without waiting for lengthy additional native acceptance; the owner
will validate the installed Windows App. Other validated platforms need not wait
for Windows. No replacement of the owner's installed Mac App or public App Store
submission was requested.

Baseline: 1.4.1, source `a1b3d952ee2f8d8b7911fae6d58c9dfe785cec40`.
This patch includes system-browser handoff for Google sign-in, phone-only iOS ADHD
text sizing (also shipped in iOS 1.4.1 build 2), history-search pagination layout,
Android safe-area restoration after background changes and reader reloads,
compatibility widget delivery guidance and error feedback, macOS DeepSeek Office
font-scan mitigation and its scoped watchdog, and Windows DeepSeek Desktop CLI
discovery. The shared Host/CLI changes require a matching standalone package and
isolated clean-install/upgrade verification.

Editor pins, adapted skills, mobile dependencies, native identities, signing
identities and update protocols are unchanged. The owner approved the sole
post-freeze security exception on 2026-11-15: update the bundled desktop Node
runtime from 24.22.2 to the 24.22.3 security release and rebuild/revalidate the
Mac and Windows packages. This changes only the pinned runtime and official
archive checksums. The standalone CLI uses its externally installed Node runtime.
The original security review omitted this runtime advisory; record the corrected
review and a new source freeze before publication. Baoyu remains at 2.15.2; no canvas paste
backport or new clipboard flow is included. Baoyu updates are no longer a
mandatory release item under the 2026-11-15 owner amendment. Check the remaining
listed integrations and shipped-code advisories before freeze without performing
an unrelated dependency refresh.

Run the source/build/native gates and the affected browser/Electron regressions.
Preserve earlier failure/reproduction and independent review receipts with their
actual source boundaries. The Android window code needs native emulator checks;
browser geometry alone cannot certify it. New packages need source/lock provenance,
icons, signatures, unpacked privacy checks and final downloaded-byte verification.
Record simulator/emulator, physical-device and Windows-owner acceptance separately.
This document is a release plan, not a statement that those gates have passed.

The iOS distribution target remains the existing TestFlight application and group.
Upload and Apple processing/review are distinct from external availability. Keep
the existing public invitation and report its actual version availability.
Existing canvas/PPT repair reentry and incomplete WebKit acceptance are not fixed
by this patch. No unrelated UI or homepage redesign is included.
