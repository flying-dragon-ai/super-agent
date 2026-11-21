# Cross-host Bot message permissions

Available from Open Super Agent 1.2.0, this guide covers the
App Cross-host scope and CLI `messages grants --cross-host`. Existing released
versions can use the receiving owner’s `messages allow` / `messages revoke`.

Open the **receiving host** in the App, then **Settings → Bot message permissions
→ Cross-host**. Bot settings opens the same permission page with that Bot as
the recipient. The Local scope continues to manage messages within one host.

1. Join the hosts to the same Open Super Agent network in Devices & Network.
2. Choose **Sending computer** and **Sending Bot**. This host's Bots are listed below
   under **Allowed local Bots**
   with their avatars and presence; existing permissions are already checked.
3. Check or clear several receiving Bots, then select **Save permissions**. The
   App signs only the changed targets as one command with the receiving owner's
   authenticated device, then reads every change back from that host.

The layout follows the Local scope. Sending computer and Sending Bot use the
platform's select; same-name entries carry an ID tail. Source Bot names come
from another host and are shown as text only; this host's avatars and presence
appear only for receiving Bots. Choosing a source, searching or discarding
writes nothing and is not an unsaved change. While a change is unsaved, the
source choices are locked so it can't be applied to another source. Opening the
page from Bot settings lists that Bot first; it is never checked automatically.
One save changes at most 256 receiving Bots. Details and the exact-ID entry are
under **Details and manual Bot ID**.

When this App is connected to the source host, ordinary Bots can be selected by
name. Internal workers are hidden; a manually entered ID matching a known
worker is also rejected. Without a live authenticated source connection, an
exact Bot ID can be entered with an explicit unverified-name notice. The
receiving host cannot independently verify the remote Bot's role or existence;
manual IDs retain the existing owner-controlled CLI semantics.

Authorization is one-way. It allows listing the receiving Bot's conversation
names and sending collaboration messages and files. The sender can retrieve
only replies to its own tasks; receiving the original task result does not need
a reverse grant. Joining a network or connecting the App does not grant Bot
message access automatically. Bots cannot approve their own access.

Existing CLI permissions appear in the same list. Clearing a permission blocks
subsequent sends and result queries without cancelling work already submitted.
Sources that have left the network, deleted recipients and known internal
sources appear under **Revoke-only permissions**, each with its own
**Revoke access**; they can't receive new permissions.
Internal worker-target records remain stored and excluded, consistent with the
Local scope; existing CLI administration of those records is unchanged.

Network or permission changes invalidate an unsaved draft. If a save receipt
is lost, the page keeps an unconfirmed result until the owner explicitly reloads
and checks; it never retries the mutation automatically. Older receiving hosts
show an update instruction while Local permissions continue to work.

The CLI remains available: `open-super-agent messages grants --cross-host --json`
reads the same cross-host snapshot. `messages grants` without the flag still
lists local grants, and existing `messages allow` / `messages revoke` commands
retain their behavior. `messages revoke` also removes a residual edge from a
removed or departed source host, or to a deleted recipient, when given the exact
`hub_…` host ID and Bot IDs (names resolve only hosts still listed in the current
membership and undeleted Bots); no record is created when no current grant exists. See [CLI usage](../host-cli.md).

Regression coverage includes owner/device proofs, replay and command tampering,
revision changes, removed peers, deleted targets, CLI compatibility, both grant
and revoke receipt loss, real isolated Hub messaging, source-name selection,
and Chinese/English browser layouts at phone and desktop widths. Browser
`cross-host-grant-list` covers the page against a receiving-Host double:
changed-targets-only batches, draft locks, searching and discarding without
writes, lost receipts and partial readback, revoke-only records, same IDs on
two hosts, directory changes, the 256-target limit and 320/390/desktop widths
in both languages. The list changes no CLI or authorization behavior. The sticky
status notice covers the scroll container’s bottom inset without exposing or
allowing clicks through to hidden content; pixel and hit-testing regressions
cover desktop and phone safe areas. This presentation fix changes no CLI or
authorization behavior. Isolated Hub
and browser tests do not establish physical multi-machine, native mobile,
installed-App or real-model acceptance.
