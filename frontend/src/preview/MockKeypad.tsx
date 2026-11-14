// DEV PREVIEW ONLY: a picture of the phone's decimal keypad, so the screenshots
// show what stays in thumb reach while typing an amount. The real app uses the
// native keypad (inputmode="decimal"); this is never rendered in the app.
import { Icon } from "../components/Icon.tsx";

export const KEYPAD_HEIGHT = 291;

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

export function MockKeypad() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-3 gap-1.5 bg-sunken px-1.5 pt-1.5 pb-8"
      style={{ height: KEYPAD_HEIGHT }}
    >
      {KEYS.map((key) => (
        <div
          key={key}
          className={
            key === "." || key === "del"
              ? "flex items-center justify-center text-2xl text-fg"
              : "flex items-center justify-center rounded-md bg-surface text-2xl text-fg shadow-1"
          }
        >
          {key === "del" ? <Icon name="backspace" size={26} /> : key}
        </div>
      ))}
    </div>
  );
}
