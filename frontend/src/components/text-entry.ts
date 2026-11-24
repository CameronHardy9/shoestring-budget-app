// Which elements bring up the phone's on-screen keyboard. Used to keep focus
// (and so the keyboard) in a text field while chips and buttons are tapped.
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "button",
  "submit",
  "reset",
]);

/** Fields that bring up the on-screen keyboard. */
export function isTextEntry(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}
