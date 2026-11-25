// Text the person typed (names, payees), where layout needs to know about it.

/**
 * Longer than any everyday English word in a category name ("Transportation"
 * is 14), so a column never shrinks below one of those.
 */
const LONG_WORD = 16;

/** Whether some word in it is too long to keep whole in a narrow column. */
export function hasLongWord(text: string): boolean {
  return text.split(/\s+/).some((word) => word.length > LONG_WORD);
}
