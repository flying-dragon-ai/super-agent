import type { Definition, List, Nodes, Parents } from "mdast";
import { parseMarkdownSyntax } from "./markdown-parser.js";

// Children of these nodes are blocks; every other parent holds one line of prose.
const containers = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
const indent = (value: string, width: number) => value.replace(/\n(?=[^\n])/g, `\n${" ".repeat(width)}`);

/** A readable copy of one Markdown source for chat apps and plain editors.
 * It follows the renderer's own syntax tree: only delimiters that tree treats
 * as markup are dropped. Text the message shows literally (including `*`, `#`,
 * `_` and `-`), code, link targets, formula notation and raw HTML keep every
 * authored character. Runs inside the Markdown Worker. */
export function markdownPlainText(markdown: string): string {
  // A byte-order mark is not content, and would shift every source offset.
  const source = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const tree = parseMarkdownSyntax(source);
  const definitions = new Map<string, Definition>(), referenced = new Set<string>();
  const scan = (node: Nodes): void => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === "linkReference" || node.type === "imageReference") referenced.add(node.identifier);
    if ("children" in node) node.children.forEach(scan);
  };
  scan(tree);
  const authored = (node: Nodes): string => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    return start === undefined || end === undefined ? "" : source.slice(start, end);
  };
  // A label and its destination both survive. An autolink is written once.
  const linked = (label: string, url: string): string => !url ? label : !label.trim() ? url
    : label === url || `http://${label}` === url || `mailto:${label}` === url ? label : `${label} (${url})`;
  // Authors' spacing is kept: blocks separated by an empty line stay separated by one.
  const apart = (before: Nodes, after: Nodes): string =>
    !before.position || !after.position || after.position.start.line - before.position.end.line > 1 ? "\n\n" : "\n";
  const prose = (node: Parents): string => node.children.map(text).join("");
  const flow = (children: Nodes[]): string => {
    let result = "", previous: Nodes | undefined;
    for (const child of children) {
      const value = text(child);
      if (!value) continue;
      if (previous) result += apart(previous, child);
      result += value; previous = child;
    }
    return result;
  };
  const list = (node: List): string => {
    let result = "", previous: Nodes | undefined, number = node.start ?? 1;
    for (const item of node.children) {
      // Rendered numbers count from the first item; source numbers after it are ignored.
      const marker = (node.ordered ? `${number++}. ` : "• ") + (typeof item.checked === "boolean" ? `[${item.checked ? "x" : " "}] ` : "");
      const body = flow(item.children);
      if (previous) result += apart(previous, item);
      result += body ? marker + indent(body, marker.length) : marker.trimEnd();
      previous = item;
    }
    return result;
  };
  function text(node: Nodes): string | undefined {
    switch (node.type) {
      case "break": return "\n";
      case "thematicBreak": return undefined;
      case "link": return linked(prose(node), node.url);
      case "image": return linked(node.alt ?? "", node.url);
      case "linkReference": { const target = definitions.get(node.identifier); return target ? linked(prose(node), target.url) : authored(node) || prose(node); }
      case "imageReference": { const target = definitions.get(node.identifier); return target ? linked(node.alt ?? "", target.url) : authored(node) || (node.alt ?? ""); }
      // A used definition already accompanies its link. An unused one is content nobody else carries.
      case "definition": return referenced.has(node.identifier) ? undefined : authored(node) || `[${node.label ?? node.identifier}]: ${node.url}`;
      case "footnoteReference": return `[${node.label ?? node.identifier}]`;
      case "footnoteDefinition": { const marker = `[${node.label ?? node.identifier}] `; return marker + indent(flow(node.children), marker.length); }
      case "list": return list(node);
      case "table": return node.children.map(row => row.children.map(prose).join("\t")).join("\n");
    }
    // Text, code, formulas and raw HTML: the authored value, never re-read as Markdown.
    if ("value" in node) return node.value;
    if ("children" in node) return containers.has(node.type) ? flow(node.children) : prose(node);
    return authored(node);
  }
  return text(tree) ?? "";
}
