# Readable mobile message copying

Mobile message copying previously wrote the Markdown source into the clipboard.
The phone's Select text sheet also showed that source, so native selection and
Copy included formatting delimiters when pasted into a chat app.

The phone message menu now copies readable text, and Select text exposes the
same conversion. Native iOS and Android use this policy in wide layouts too,
including expanded phones and tablets. Desktop message bars and context menus
continue copying the source. Rendered DOM selections, code-block copy, composer
editing, quote, forward, export and stored message blocks are unchanged.
Separate report-reader and prompt-queue copy actions retain their existing
behavior; this change targets the conversation's message actions.

Only fields rendered as Markdown are converted. Attachment names, card titles,
form labels and option labels remain literal. The shared Markdown syntax parser
removes formatting delimiters while retaining code content, literal punctuation,
link labels and destinations, list numbering, task state, table rows and columns,
formula source and reference information. Tables use tabs between cells. No
regular expression strips punctuation from the entire message.

Conversion runs in a separate instance of the existing Markdown Worker asset.
It does not join or alter the rendering queue. A bounded cache avoids repeat
work; stalled conversion times out and idle workers terminate. Clipboard writes
start synchronously in the user's click, with a promised text item when needed.
If conversion is unavailable, the complete original is copied with an explicit
notice. Clipboard denial follows the existing error path, never a success hint.
Selection preparation cannot display another message's text. Each copy request
owns its feedback; a later copy, leaving the conversation, hiding/unmounting the
workspace or deleting the message prevents obsolete feedback.
A later message copy supersedes an unfinished conversion, including across
visible conversation panes. A rejected promised clipboard write is not retried
afterward, since that could overwrite a newer selection or code-block copy.
`clipboard-write.ts` retains the existing write arguments, timing and errors
while invalidating pending message conversions. Copy/Cut events are observed
only while a message write is pending, without preventing or changing native
copying. New App clipboard writers should use this same wrapper. Clipboard
feature detection checks that `write` is a function before using rich items.
This ordering covers actions in the same App page and its native copy events;
it does not monitor other applications, windows or embedded-frame copy events,
and never reads clipboard contents. Existing pending image conversions retain
their prior completion policy; this patch guards delayed message conversions.

This is an App presentation change. Host protocols, storage, CLI commands,
engine adapters, dependencies and native platform code are unchanged.

## Validation boundary

Focused syntax and worker tests cover formatting, literals, long content,
failure recovery, caching and cancellation. Browser tests cover phone menu and
native selected-text paste, iOS/Android wide-layout policy, unchanged desktop
source copy, real clipboard writes, quoting/forwarding and stale-copy feedback.
The focused suite includes 135 unit tests and the client translation/type/build
checks. The standalone Host build also passes; no Host behavior changed.
The final client build passes 36 Chromium App regressions for message actions,
selection, context menus and image copying. Five real clipboard checks pass in
each of Chromium and macOS WebKit. Independent Fable review identified the
delayed-copy race; the corrected shared-write ownership was reviewed again.

Native WebKit clipboard checks use an isolated page without Host pairing; both
cold promised writes and cached synchronous writes are pasted back and compared.
They also cover a failed conversion and a delayed first copy followed by either
another message copy, another App clipboard action or native keyboard Copy. The delayed-write overwrite was
reproduced before the guard and passes with it.
The existing complete-App WebKit phone-selection baseline timed out during
pairing, before reaching the changed copy action. It is not a passing App test.
The Chromium collaboration regression also had an obsolete `.offline-banner`
assertion that failed on the unchanged base. It now checks the current phone
connection notice while retaining the offline-draft and message assertions.
Physical iPhone/Android selection handles and pasting into WeChat have not been
verified by these browser checks. No package, release or installed App is changed
by this source patch.
