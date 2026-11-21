# Codex web-search citations

A native Codex reply could expose a raw `cite` control containing an opaque
reference such as `turn2search5`. This is shared Host presentation behavior, not
a macOS-specific font or connection failure. The previous adapter read only
`webSearch.sources`; Codex 0.170 also supplies opaque `webSearch.results` entries
with `type: text_result`, `ref_id`, `url` and `title`.

The field mapping is confirmed by the local 0.170 protocol schema and the
[upstream app-server fixture](https://github.com/openai/codex/blob/0e8c7683c4a85f00667bd762265358a407124f2e/codex-rs/app-server/tests/suite/v2/web_search.rs).
An agent message has no separate URL-annotation field in that schema.

## Behavior and boundaries

- Keep the old `sources` format and extract explicitly identified text results.
  Never infer reference IDs from source array order.
- Resolve exact IDs into ordinary Markdown links in final adapter results and
  shared run-card presentation, including streaming element updates and compact
  cards. Recovery uses the requested turn's final items, never another turn.
  The run controller retains sources across engine retries and resolves the
  final answer before cleaning and overflow splitting. Message, cron and
  card-action entrypoints share this path; goal watchers own a separate map.
- Keep at most 256 mappings per run; conflicting IDs cannot select a URL.
  Accept HTTP(S) without embedded credentials. Show the destination hostname
  as the link label, not a site-provided title. Encode source labels and link
  punctuation so search metadata cannot become delivery or tool directives.
- Hide incomplete control tokens while streaming. A missing source is shown as
  “来源链接未提供” or “Source link unavailable”, rather than an invented link or
  silent deletion of attribution. Ordinary text and fenced/inline code examples are retained.
- Preserve delta events and raw run evidence. The internal resolution ID does
  not change the public run-journal schema or imply evidence truncation.
  Run-detail prose and side answers derive clean display text from the complete
  raw buffer; side copy/insert use that derived text too. Raw-step copy remains
  raw for diagnostics. Streaming side replies can temporarily show unavailable
  sources until their final adapter result resolves the links.
- Mapping is deliberately run-scoped. References to earlier user turns that are
  not returned in the current turn cannot be resolved. There is no persistent
  source cache, extra model request, or new thread-history read in the hot path.
  Previously saved messages are not rewritten. Source-cap overflow and
  conflicting IDs also fall back to unavailable attribution. Adjacent missing
  citations can produce repeated notices. Citations placed inside an existing
  Markdown link label are not specially flattened.
- Client-side run-detail and side-view improvements require the client update;
  updating only the Host fixes its cards and final answer delivery.

The headless Host uses the same adapter and rendering/delivery helpers. No new
CLI command, native UI, dependencies, version or release policy is needed.
Other engines' ordinary replies and existing Codex file citations are unchanged.

## Verification

The initial regression reproduced raw controls, incomplete streaming controls,
and missing structured search results (three failures before the fix).
Coverage includes explicit/ambiguous/unsafe sources, mixed missing references,
code spans and fences, final summaries, requested-turn recovery, scoped events,
run-journal evidence, App rendering and delivery fallbacks.

Validation on the reviewed change:

- 810 tests in 13 focused Host/adapter/delivery files passed, including main,
  cron and card-action finalization plus retry ownership.
- Eight Chromium checks passed: Chinese/English at mobile and desktop widths,
  real App/Gateway answer and run details, side streaming/copy/insert, and
  existing side navigation/draft/stop behavior. Table URLs containing pipes
  retain their two-column layout.
- Host standalone build and client build (including client TypeScript and
  translation checks) passed. Root `tsc --noEmit` reports the same 181 baseline
  diagnostics as the base revision, with no new diagnostics after path
  normalization; it is not a clean repository-wide type-check result.
- Independent Opus review confirmed the retry and side-buffer fixes and found
  no remaining blocking finding within this scope.

Source and browser verification do not certify an installed App or a live
provider conversation. No release or installed-App update is part of this change.
