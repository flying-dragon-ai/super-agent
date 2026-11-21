# Open Super Agent version policy

`release-version.json` owns the product version and platform build counters.
The first unified product line is **1.1.0**. It is newer than the released
App 1.0.130 and CLI 0.1.475; neither old release is renamed or overwritten.
This change does not publish a release or install an App.

| Change | Increment | Example |
| --- | --- | --- |
| Fixes, compatible reliability/security/UI corrections | PATCH | 1.1.0 → 1.1.1 |
| Compatible new functionality or product-wide rebranding | MINOR | 1.1.2 → 1.2.0 |
| Incompatible public CLI, persisted-data or protocol contract requiring migration | MAJOR | 1.4.3 → 2.0.0 |

Choose the largest applicable increment for a release. Commits, PRs and build
retries do not each get a new product version. Do not reset to 1.0.0 on rename
or use dates as semantic versions.

## One version across distributions

Mac, Windows, Android, iOS, the bundled Host and standalone CLI share the product
version and source commit. `scripts/release-version.mjs` synchronizes root/client
package manifests and locks, the native App manifest/Cargo package and lock,
Android defaults, and all iOS App/share-extension build configurations.
The pre-commit/pre-push and GitHub privacy workflow reject drift.

```sh
npm run version:check
npm run version:bump -- patch
# For a deliberate manifest/build-counter edit:
npm run version:sync
```

The manifest `status` is `development`, `rc` or `stable`; it describes intended
source maturity, not verified publication. Native stores receive the numeric
product version; preview/RC status belongs in the GitHub prerelease flag and
release notes. Do not publish an RC to the stable updater manifest. Version
bumping resets the iOS build to 1 for the new marketing version and increments
the Android code. A rebuilt upload of the same marketing version increments its
platform build counter before packaging. Android's code must always exceed
the previous store build and remain ≤ 2100000000; its retained initial value
continues the old counter and is no longer interpreted as a date.

After any upload, record product version, platform counter, source SHA, channel,
artifact digest, signing/readback results and acceptance scope. A corrected
GitHub package may replace an asset under the same product version. Rebuild and
verify the replacement; update the corresponding signatures, checksums, update
manifests and source binding together, retain the previous hashes in private
release evidence, and describe the replacement in the release notes. State that
clients already on the same version may require a manual download. Android
rebuilds increase versionCode; TestFlight re-uploads increase the build number.
Store upload counters are never reused for different bytes.

On 2026-11-11 the owner removed the previous same-version asset replacement
prohibition and requested a corrected 1.3.1 release, including replacement of
the Android package. This supersedes the briefly prepared 1.3.2 plan.

Internal non-distributed helper crate package versions (currently 0.1.0),
database schema numbers, tool-schema versions, capability versions and upstream
dependency versions are not product versions. Advance their own contracts only
when required. The release manifest still binds their packaged bytes/source.

## Android channel counters

Future Android releases use one visible version and one `androidVersionCode`
for the GitHub APK and Play AAB, built from the same commit. Check both channels'
accepted uploads, including Play drafts, before reserving the manifest counter;
the next release must exceed the highest consumed code. A channel that finishes
later uses the reserved release code rather than incrementing it independently.

The initial 1.5.0 transition is exceptional: GitHub consumed `2026110412` and
Play accepted `2026110413`. The Play correction reserves `2026110414` while
keeping the visible version **1.5.0**. Updating the manifest does not replace the
already published GitHub APK or publish the Play correction. The next shared
release must therefore use at least `2026110415`, subject to checking intervening
uploads. Record any further correction before another channel is packaged.

## Existing update clients remain compatible

Publish future releases only to `cloveric/open-super-agent`, with English titles and
release notes. The clean repository migration publishes no release and imports
no historical tags or assets. Retain the current platform tag prefixes, such
as `macos-open-super-agent-v1.2.0`, `windows-open-super-agent-v1.2.0`,
`android-open-super-agent-v1.2.0` and CLI `v1.2.0`; these carry the **same** version.
New distribution filenames come from `scripts/release-artifact-names.mjs` and
use open-super-agent. Compatibility update-manifest names retain their current spelling.

A canonical `vX.Y.Z` Release page may collect all platform downloads and the
TestFlight link. The repository homepage points to `/releases/latest`. This
presentation does not replace the platform update channels: released clients
through 1.3.1 only recognize their platform tag prefix. Keep their compatibility
releases and original assets available until a separately tested updater
transition is shipped. Do not interpret a unified download page as evidence
that installed clients can discover its tag.

For the next packaged transition (planned for 1.3.2), readers should accept both
canonical and platform tags. Publish the transition build through the legacy
channels too, so older clients can reach it before discovering later unified
releases. This is a migration plan, not implemented or packaged behavior.
On 2026-11-12 the owner authorized removing Release pages/assets older than
1.3.1 while preserving the 1.3.1 compatibility channels and source tags.

## Candidate first, stable after owner acceptance

From 2026-11-20, all platforms follow owner trial, then an authorized public RC,
then explicit owner approval for stable publication. This replaces the previous
Windows default of direct formal publication. A routine release request covers
preparing and publishing an RC; it is not approval to promote it to stable. See the
[release procedure](release-checklist.md#candidate-and-stable-publication).

Keep the numeric product version, such as `1.5.2`, inside native packages and
updater manifests. Use `status: rc` before freezing the candidate, the GitHub
prerelease flag and English titles/notes such as `Open Super Agent 1.5.2 RC1` to describe
its maturity. A title suffix alone does not keep a build out of stable updates.
The unified page and every platform compatibility release must remain draft or
prerelease until the owner approves promotion. Retain the prior stable downloads.

Record the candidate number, exact source and artifact digests, platform build
counters and owner acceptance. Unchanged accepted packages can be promoted
without rebuilding; changing the source manifest to `stable` afterward is a
publication bookkeeping commit, not a claim that the binaries were built from
that newer commit. Preserve the actual frozen source binding. A corrected
candidate needs fresh validation and applicable counters under the existing
same-version replacement rules. Candidate testers may need to install such a
same-product-version correction manually; stable updaters ignore prereleases
and do not promise equal-version updates.

Do not turn a missing test into a passing receipt: record new-installer, upgrade,
custom-path, uninstall and automatic-update validation separately. Historical
manual previews keep their existing tags and prerelease flags. Existing old tags remain as
historical records in the old archive. Existing installed clients still use that
archive's update endpoint; the first release from this repository must document
and verify its one-time upgrade path. See [repository migration](repository-migration.md).

Publishing still requires the owner's explicit release instruction and the
[release checklist](release-checklist.md). Source tests and a synchronized
manifest are not signed-package, store-processing or installed-device acceptance.

## Platform-scoped patches

An owner-authorized [scoped patch](release-checklist.md#scoped-patch-releases)
may publish only affected platform channels. Every newly published App and CLI
artifact still has the synchronized source version and commit. Unaffected
channels retain their earlier version; do not rename, re-sign or re-upload old
bytes as the patch version. Source mobile counters may advance without a store
upload; the next actual upload must still be monotonic.
