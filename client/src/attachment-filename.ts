/** A server-supplied label is never a filesystem path. */
export function attachmentFilename(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "");
  const suffix = /\.[a-z0-9]{1,16}$/i.exec(sanitized);
  const extension = suffix && suffix.index > 0 ? suffix[0] : "";
  const stem = (extension ? sanitized.slice(0, -extension.length) : sanitized).replace(/[. ]+$/g, "");
  const prefix = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem + extension) ? "_" : "";
  let clean = "", bytes = prefix.length + extension.length;
  // Reserve the complete extension and any Windows device-name prefix before
  // truncating, while keeping Unicode code points and the final byte budget.
  for (const character of stem) {
    const size = new TextEncoder().encode(character).length;
    if (prefix.length + clean.length + character.length + extension.length > 160 || bytes + size > 240) break;
    clean += character; bytes += size;
  }
  clean = clean.replace(/[. ]+$/g, "");
  return `${prefix}${clean || "attachment"}${extension}`;
}
