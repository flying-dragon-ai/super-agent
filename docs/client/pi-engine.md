# Pi native engine

Open Super Agent runs [Pi](https://github.com/earendil-works/pi) as its own engine through
Pi's JSONL RPC transport. It does not translate requests into Codex or another
engine. The integration is checked against Pi 1.5.2 and 1.6.0. Pi is an ordinary Bot
engine; it cannot be selected as a Chancellor (Chief of Staff) or a dispatched
engine worker. This development integration is not yet in a stable release.

## Install and select

Install Pi and configure its providers under the operating-system user running
the Host. Native login is `pi auth login`. Existing Pi provider, model, skill,
extension and MCP settings remain Pi-owned. Open Super Agent does not copy credentials
into Bot settings or return them in model catalogs.

Create a Bot, select **Pi**, then choose a provider and one of that provider's
available models. **Follow Pi default** keeps native selection. Model discovery
uses Pi's available-model RPC, including custom and local providers; an empty
catalog is shown as no usable models, not as a successful connection to a
placeholder model. Refresh the catalog after changing native authentication or
provider configuration. Missing models and provider authentication failures show setup guidance rather
than suggesting an instance restart. The inactivity watchdog is reported as
inactivity, not as a total runtime cap. Catalog-only reads disable MCP startup and use a private
empty directory when no workspace is selected; provider extensions still load.

Executable discovery is shared by launch, Doctor, engine settings and Bot
availability. An explicit setting or `PI_EXECUTABLE` wins and never falls back
silently if invalid. Automatic discovery considers PATH and deterministic npm
and native installer locations. A custom native directory can be selected with
`PI_CODING_AGENT_DIR`. Candidates are not run just to determine their presence.
At launch, a bare executable name must resolve through an absolute PATH entry;
a workspace-local lookalike is never used as a missing-install fallback. Relative
PATH entries such as `.` are not used for this resolution. Orderly shutdown
closes stdin first, then ends the process tree while its launcher is still alive.

## Models and thinking

A Pi model is a **provider and native model ID pair**. Two providers may expose
the same model ID, and a native ID can contain slashes or colons. Open Super Agent keeps
the pair intact; it does not infer a provider from a model's display name. Canonical
App/CLI IDs percent-encode identity components, retaining readable model path
separators. Duplicate display names include the native model ID.

Bot settings define the default for its conversations. An actual change to that
default is applied on their next turn, independently for model and thinking.
Changing only thinking does not reset the conversation's model. A Bot-only
model change retains the previous thinking level when the new model supports
it. An unchanged Bot-owned effort is validated before changing the model and
reapplied afterward, including recovery from an uncertain write that already
landed. Incompatible Bot defaults are explicitly rejected. A conversation's own
unsupported level uses Pi's native clamping with a notice. Direct native `/model`
changes retain Pi's own per-model/default-thinking behavior.
A native `/model` or `/thinking` selection belongs to its conversation and persists
across subsequent turns while that individual Bot default remains unchanged.
A conversation choice made after a Bot default was saved takes precedence over
that pending default in the same field; the other field is still independent.
When an unavailable model or incompatible thinking default is rejected, `/model`,
`/thinking`, and bare `/session` remain available with a notice so the owner can
recover. Ordinary prompts still fail, and these commands do not bypass unreadable
configuration, stale ownership or uncertain native writes.
Restored native sessions retain their recorded
selection unless that Bot default has changed. Clear a Bot override to return
to the native default; **off** explicitly disables thinking and is different
from an empty override. Clearing a conversation thinking override when the Bot
has no thinking default leaves the current native level unchanged. Only thinking
levels reported by that model are offered; provider-specific aliases and disabled
levels remain native metadata rather than a hard-coded list.

The Pi control in a direct conversation adjusts that **current conversation**,
including while a turn is running; model changes apply to subsequent native
model calls. Bot-wide defaults stay in Bot settings. Opening the conversation
panel does not start a worker or create a session. A missing live session needs
a message first. Native extension status and widgets appear as text in this
panel with terminal styling and control characters removed; ordinary text,
paths, line breaks and emoji remain intact. Suggested editor content never
overwrites an unsent draft. Search results identify the provider across the full
catalog. Empty or unavailable catalogs offer an explicit refresh action.

If a change's result is uncertain, checking reuses its request ID. It does not
repeat the native operation. An unresolved native timeout prevents further
changes to that same live worker, since the original write might still finish.
After its task finishes, restart the Bot and reload the panel to use the new
worker. This does not claim the old operation was cancelled. An unavailable
model or unsupported thinking level, including a reset to the Bot default, is
a known rejection and does not lock the panel. A write followed by an unconfirmed
state read remains uncertain.

RPC commands cancelled or timed out while still waiting behind stdin
backpressure are discarded before writing. Commands already sent retain the
uncertain-outcome rules above; cancellation is not a rollback. A startup request
whose signal is already aborted launches no process. Large JSONL replies are assembled from
fragments without repeatedly rescanning the accumulated history. The per-record
limit remains 256 MiB and is enforced in UTF-8 bytes, including Unicode and the
final unterminated record.

A message cancelled while waiting for the workspace or a shared process to
become ready does not begin a turn or send a prompt. A ready process can still
serve another caller. Retiring the adapter interrupts unfinished model and
native-command turns; a partial reply or command failure is not reported as a
completed result. A process that exits or is retired during final startup
registration is never published as live.

## Permissions and tools

Normal mode asks for approval for shell commands, writes and other tools that
are not verified built-in reads or Open Super Agent's own App tools. Bypass mode uses Pi's
unrestricted native execution. Neither mode is an operating-system sandbox. `/yolo on` cannot enable a
sandboxed full-auto mode in Pi and leaves permissions unchanged; `/yolo off`
and `/yolo unsafe` select normal approval and bypass respectively.
Approval decisions belong to the current Bot and session; another conversation
does not inherit a tool approval accidentally. A disconnected approval bridge
cannot authorize an operation.
Oversized approval inputs are shown as a partial preview, with omitted items,
fields and text identified. The tool still executes with its full original
arguments; shortening the preview does not shorten the operation.

The bundled extension connects to a private authenticated local endpoint. It
provides App tools and per-turn instructions without modifying the owner's
global Pi configuration. Native extensions and skills still run in Pi. Structured extension errors,
including those emitted during startup, appear in the owning turn's run details;
the final reply carries a count-only notice. At most 20 error details are shown
per turn; further errors are counted. Terminal escape codes and common credential
assignments are removed from diagnostics. Extension-only notifications remain in
the run details; a fixed final notice cannot execute embedded delivery directives. They are not silently discarded or
replayed on every later turn, and their text cannot become a final file-send
directive. Native
select, confirm, input and editor requests use App question cards, including
multi-line text and explicit empty answers. Pi selections retain their option
positions, so equal labels, surrounding whitespace and commas do not change the
selected native value. Blank titles and options have visible placeholders.
Ambiguous label-only answers are rejected rather than guessed.
Native terminal-only rendering is
not reproduced as an embedded terminal.

## Sessions and commands

Bot conversations have separate native session files. `/resume` validates a
native session and binds its actual workspace; a forged path in a stale card
cannot replace the validated path. `/detach` leaves the native history intact.
Forking or creating a session updates the conversation binding only after Pi
confirms the new identity.
Imported copies receive a session-id suffix so they can be rediscovered after
the worker exits. Existing imports with a custom filename are matched by a
bounded header scan in this Bot's session directory; the header identity and
workspace must still match. The original file is not overwritten.

Native session discovery follows Pi's `PI_CODING_AGENT_SESSION_DIR`, project and
user `sessionDir` settings, and default workspace directory. Tilde, relative and
Windows shell drive paths are resolved in the same workspace context as the Pi process. Discovery
reads settings without rewriting them. Controls without an explicit conversation
workspace read the current Bot configuration. Workspace links/junctions and
Windows path casing are compared as Pi compares them; a different workspace
is still rejected, including while that session is starting. A linked workspace
may request project trust again when its physical path is first used. On Windows,
Pi starts with the configured logical junction path; discovery checks its native
session directory and the target directory, deduplicating session IDs.

The native tree includes replies, tool results and summaries, honoring Pi's
`treeFilterMode` and `branchSummary.skipPrompt`. An exact entry ID can select a
valid node even when the current filter hides it.

Pi built-ins are intercepted before a model prompt: model and thinking
selection, session statistics and naming, tree navigation, forks and clones,
compaction, settings, reload, copy and export use native controls. `/trust` stores
project trust for this Bot and workspace, not in the global Pi trust file.
`/scoped-models` limits the Bot process selection without editing the user's global
model scope. `/import` requires an explicit confirmation and a native session
from the same workspace; JSONL export can be imported again. `/session` includes
native usage and a per-model cost breakdown. Commands that
require Pi's terminal surface explain where to run them; they are not submitted
to a language model as ordinary text. `!` and `!!` retain Pi shell-command
semantics and respect Normal-mode approval.
Commands are parsed from the owner's typed text, separately from quoted replies
or media context. A quote is never appended to a shell or extension command's
arguments. Templates and skills may receive that context as model input.
Bot messages, scheduled work, delegation and recovery prompts are model input,
not native Pi commands. Confirmations show both the title and explanation,
including the scope of user-wide settings. Replies produced by native commands
display tag-shaped text literally, so `/copy` cannot resend an earlier file or
recreate an earlier schedule. Explicit exports still use the request's output
directory and ordinary model deliveries are unchanged.

In a direct chat, plain text supplements the current Pi task by default. Choose
**Next turn** to use Open Super Agent's visible Host queue. This queue is separate from
Pi's internal follow-up queue. The composer also routes `/model`, `/thinking`,
`/name`, `/session`, `/copy` and `/settings` to the live native session rather
than waiting for the current task to finish. Other App commands retain their
App behavior. A definite refusal because the task has stopped receiving input
falls back to the Host queue only while the original draft is unchanged. An
edited draft is preserved for the owner to send.

If a supplement's admission is uncertain, the App retains its request identity
across reloads and checks the original receipt. Choosing **Next turn** cannot
resend that same unresolved input as another task. Edit the text only when you
intend to send a new message. Once admission is confirmed, editing a different
draft retires only that confirmed receipt; an intentional later repeat is a new
send and does not overwrite the intervening draft.

At stop and normal settlement, unconsumed native input is taken back and its full
text is preserved in the run process; templates and skills appear as the expanded
text Pi actually held. The final reply includes a short warning when additions
were not delivered. They are never resent automatically, and existing drafts are
not overwritten. An in-flight input must finish before the final queue clear;
if Pi cannot confirm that the queue is empty, the Host ends that Pi process while
retaining its session history. The warning leaves delivery uncertain rather
than claiming the additions were never applied.

The command menu lists Pi's public built-ins in both languages. An existing
live session also contributes its extension commands, prompt templates and
skills. Reading the menu does not start a worker; one conversation's native
commands are not shown in another conversation. App commands keep precedence
when names collide. Descriptions distinguish conversation changes, Bot defaults
and actions that require the native terminal. While a task is running, prompt
templates and skills can supplement it. Registered extension commands wait for
their own Host turn, so asynchronous handlers and their approval requests remain
owned by a visible task. This differs from Pi's terminal live dispatch: its public
bridge dispatch API does not expose an awaited completion for those handlers.
The command remains available; it is not silently dropped or retried.

The capabilities page reads Pi's configured agent directory, root Markdown skills
and nested skill directories, with bounded scanning and canonical-file deduplication.
It also lists the managed Search MCP when launch policy would enable it. This is
still a partial metadata catalog, not proof of loaded or working tools. Background
Host environments preserve Pi's native agent/session-directory settings, including
relative and tilde forms; native Pi resolves them in its workspace.

Pi program-path settings and service environment overrides require a Host
runtime declaring `pi-state-v1`. The managed-service and CLI update preflight
reject an older runtime that cannot read those keys, before changing the
service or settings. To return to such a runtime, first reset the Pi program
path and reinstall the service without Pi environment overrides, as indicated
by the error. Other engine settings are preserved. This preflight cannot
protect an old executable launched manually outside the managed update flow.
A Pi-capable runtime can still start its service when engine settings need
repair; each engine retains its own strict settings reader. An older runtime
is refused when unreadable settings prevent verifying compatibility.

## Implementation and verification boundaries

- `src/runtime/pi-executable.ts`, `pi-model-discovery.ts` and
  `src/codex/pi-models.ts`: shared discovery and provider/model identity.
- `src/codex/pi-rpc-client.ts`, `pi-rpc-protocol.ts`: JSONL framing, responses,
  cancellation and startup failures.
- `src/codex/pi-rpc-adapter.ts`, `pi-session-store.ts`, `pi-turn-mapper.ts`:
  session ownership, defaults, turn lifetime and native event mapping.
- `src/codex/pi-bridge-extension.ts`, `pi-bridge-host.ts`: private bridge,
  project trust, approval and App tools.
- `src/codex/pi-native-commands.ts`, `pi-native-types.ts`: native command mapping.
- `client/src/PiModelSelect.tsx`: provider/model controls shared by creation
  and model settings. Pi is excluded from Chancellor creation and conversion
  in both UI and Host validation.

Use the Pi unit and protocol regressions, then `client/e2e/pi-engine.spec.ts`
`pi-questions.spec.ts`, `pi-session.spec.ts`, `pi-ui-controls.spec.ts` and
`pi-send-choice.spec.ts` for Chinese/English and phone/desktop layouts.
Credential-free native RPC probes, mocked providers, browser fixtures and an
installed App are different evidence. Windows native process/pipe behavior,
physical phones and real provider authentication must not be described as
verified merely because source tests pass. See the
[November parity review](pi-parity-review-2026-11-20.md) for this round's evidence
and remaining verification limits.

## Headless CLI

`open-super-agent bots catalog [--workspace DIRECTORY]` and `bots model BOT` use the
same provider catalog and Bot-default API as the App. In Pi, `--effort off`
disables thinking; `--effort default` clears the Bot override.

Current-conversation controls use the same live-session API and authorization:

```sh
open-super-agent conversations pi-session CONVERSATION --bot BOT --json
open-super-agent conversations pi-session CONVERSATION --bot BOT \
  --model provider/model --session TOKEN --request-id pi-model-1 --json
open-super-agent conversations pi-session CONVERSATION --bot BOT \
  --thinking off --session TOKEN --request-id pi-thinking-1 --json
```

Read the current `session.token` before writing. `default` means clear this
conversation's override. A read cannot start a process. Keep the exact write
parameters and request ID when checking an unknown outcome; a retry reads the
stored receipt and does not repeat the operation. Use a new request ID only for
a new intended change. Both App and CLI refuse stale sessions or lost access.

## Native surface boundaries

| Capability | Open Super Agent behavior |
| --- | --- |
| Models, thinking, conversation history, tools and skills | Native Pi RPC and native extension bridge; provider identities are preserved. |
| Built-in read tools and tool approvals | Native calls with the selected Bot permission policy; no inferred approval from tool names. |
| Settings with native RPC setters | Explicit confirmation before changing Pi's user-wide setting. |
| Login/logout and settings without RPC setters | Run the indicated native Pi terminal command; no embedded terminal or credential copy. |
| Runs started independently by extensions outside an owned App turn | Not represented as standalone App tasks; use the native terminal for extensions relying on this behavior. |
| Terminal-only extension components, themes and hotkeys | Pi's RPC limitations still apply; these are not reproduced in the App. |
| `/share` and `/bug` | Explain the native terminal route; do not silently upload to upstream services. |
| Extension status/widgets | Plain text in the live Pi panel; notices and suggested editor text appear in chat. |

The Host shares the user's native provider sign-ins and installed extensions.
Native OAuth refresh can update Pi's own credentials just as the CLI does.
Bot-owned sessions, applied-default fingerprints, project trust and model scope
live under its state directory. Per-field default fingerprints are additive:
unchanged legacy pairs migrate without native writes; changed legacy pairs apply
both once because the old individual values are unknown. Forks inherit these
records and malformed new fingerprints fall back to legacy comparison.
An initial state-file read failure, other than a missing file, rejects the
operation without treating saved settings as empty or overwriting them. The
same store can retry once the read failure is resolved. Existing recovery of
readable malformed state files is unchanged.
Open Super Agent does not rewrite project instruction
files. A turn ends on native `agent_settled`, and confirmed cancellation requires
native settlement or process termination, not just a sent abort request.
