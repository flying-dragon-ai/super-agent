/**
 * Which options a Pi question card answer picked, by position.
 *
 * The shared question card reports `answers` by label, and it trims question
 * text and labels. Equal labels, labels that differ only in surrounding
 * whitespace and labels containing commas are therefore indistinguishable
 * there. For Pi requests only, the card also reports `selections`: for each
 * question, the positions of the picked options and any free text. Pi maps
 * those positions back to the values it offered; other engines keep their
 * existing `answers` contract.
 *
 * Positions line up with what Pi sent only while the card keeps every
 * question and option, and it drops blank ones. `piQuestionText` keeps text
 * non-blank without changing text that is already visible.
 */

export interface PiQuestionSelection {
  /** Positions in the options Pi sent, without duplicates. */
  readonly options: number[];
  /** Free text exactly as submitted, when the question accepted it. */
  readonly text?: string;
}

/** `value` unless it is blank, which the shared card would drop. */
export function piQuestionText(value: string, fallback: string): string {
  return value.trim() ? value : fallback;
}

/**
 * The card's positional answer for one question, or undefined when the answer
 * carries none (an older surface): callers then use the label answer. When
 * `selections` is present at all, a malformed entry picks nothing.
 */
export function piQuestionSelection(updatedInput: unknown, questionIndex = 0): PiQuestionSelection | undefined {
  const selections = (updatedInput as { selections?: unknown } | null | undefined)?.selections;
  if (!Array.isArray(selections)) return undefined;
  const entry = selections[questionIndex] as { options?: unknown; text?: unknown } | null | undefined;
  const options = Array.isArray(entry?.options)
    ? [...new Set(entry.options.filter((position): position is number => Number.isInteger(position) && position >= 0))]
    : [];
  return { options, ...(typeof entry?.text === "string" ? { text: entry.text } : {}) };
}

/** The label answer, keyed by the question text as sent or as the card trimmed it. */
export function piLabelAnswer(updatedInput: unknown, question: string): unknown {
  const answers = (updatedInput as { answers?: unknown } | null | undefined)?.answers;
  if (!answers || typeof answers !== "object") return undefined;
  const record = answers as Record<string, unknown>;
  return Object.hasOwn(record, question) ? record[question] : record[question.trim()];
}

/**
 * The single value a label-only answer names. The card shows labels trimmed,
 * so every option whose trimmed label equals the trimmed answer is a
 * candidate, even when one of them matches exactly: an exact match must not
 * hide a collision the owner could not see. Several candidates with one value
 * (the same option offered twice) still name that value.
 */
export function piLabelValue<T>(options: ReadonlyArray<{ label: string; value: T }>, answer: string): { value: T } | "none" | "ambiguous" {
  const wanted = answer.trim();
  const values = [...new Set(options.filter(option => option.label.trim() === wanted).map(option => option.value))];
  return values.length === 1 ? { value: values[0]! } : values.length ? "ambiguous" : "none";
}
