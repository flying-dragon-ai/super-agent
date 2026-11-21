# Pi RPC fixtures

Stdout records of `pi --mode rpc`, recorded from Pi 1.5.2 (`@earendil-works/pi-coding-agent@1.5.2`)
running against a loopback fake provider with no credentials. One JSON record per line, exactly
as Pi wrote it, except:

- every local path was replaced by a synthetic one under `/synthetic/`;
- loopback ports were normalised to `127.0.0.1:1`;
- the system message keeps its shape, but its prompt text, sections and tool descriptions were
  replaced by short placeholders.

Model ids (`fakeprov/dup-model`, `fakeprov/plain-model`, `fakeprov2/dup-model`), session ids and
entry ids are the ones the probe run produced; none of them is real account data.

| File | Content |
|---|---|
| `noauth-responses.jsonl` | Command responses with no usable model, plus the events a few commands emit (queue, user bash, session name, a refused compaction, the parse-error response). |
| `run-text.jsonl` | First run of a new session: system message, user message, streamed text reply. |
| `run-thinking.jsonl` | A reply with a thinking block before the text. |
| `run-tool.jsonl` | A `bash` tool call with partial results, then the reply that follows it. |
| `run-steer-followup.jsonl` | One run that takes a steer and a follow-up; the model and thinking level change mid-run. |
| `run-abort.jsonl` | A run aborted while the reply was streaming. |
| `run-error.jsonl` | A provider error with automatic retry switched off. |
| `run-error-retry.jsonl` | A provider error, the retry wait, and the retry being cancelled. |
| `run-image.jsonl` | A user message that carries an inline image. |
| `run-tool-denied.jsonl` | A tool call blocked by an extension's `tool_call` handler. |
| `run-tool-aborted.jsonl` | A run aborted while a tool call was waiting for approval. |
| `extension-ui.jsonl` | The seven extension UI request methods RPC supports, then the `handled` prompt response. |
| `session-commands.jsonl` | State, model, statistics, entries, fork, clone, new and switch responses of sessions with history. |
| `session-tree.jsonl` | One `get_tree` response of a session with two branches and a label. |

## Coverage

Session events: `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`,
`message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
`queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `compaction_start`,
`compaction_end`, `auto_retry_start`, `auto_retry_end`, `bash_execution_update`.

`message_update` kinds: `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`,
`thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`.

Responses (ok): `abort`, `abort_retry`, `bash`, `clear_queue`, `clone`, `cycle_model`, `cycle_thinking_level`,
`follow_up`, `fork`, `get_available_models`, `get_available_thinking_levels`, `get_commands`, `get_entries`,
`get_fork_messages`, `get_last_assistant_text`, `get_messages`, `get_session_stats`, `get_state`, `get_tree`,
`new_session`, `prompt`, `set_auto_retry`, `set_model`, `set_session_name`, `set_thinking_level`, `steer`,
`switch_session`.

Responses (error): `clone`, `compact`, `export_html`, `fork`, `get_entries`, `prompt`, `set_model`,
`set_session_name`, an unknown command, and the id-less `parse` response.

Extension UI requests: `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`.

Not recorded (the probes could not trigger them): a successful `compact` or `export_html`, `setTitle`,
`set_editor_text`, `extension_error`, the `summarization_retry_*` events, a successful `auto_retry_end`,
and the remaining setters (`set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `abort_bash`).
