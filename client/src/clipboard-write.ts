// A pending readable-message conversion must not overwrite a later App copy.
// These wrappers preserve the browser API and its activation/error semantics;
// they neither inspect the clipboard nor replace navigator.clipboard methods.
let latest: object | undefined;
export function claimClipboardWrite(): () => boolean {
  const request = {}; latest = request;
  return () => latest === request;
}
export function writeClipboardText(text: string): Promise<void> {
  claimClipboardWrite();
  return navigator.clipboard.writeText(text);
}
export function writeClipboard(items: ClipboardItem[]): Promise<void> {
  claimClipboardWrite();
  return navigator.clipboard.write(items);
}
