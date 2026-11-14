// Short confirmations ("Saved $42.50 to Groceries"). One polite live region,
// so screen readers announce each message once; errors are never toasts (they
// stay next to the thing that failed). Shown at the top, clear of the thumb
// zone, the tab bar and bottom sheets.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "../components/Icon.tsx";

interface ToastItem {
  id: number;
  text: string;
}

const ToastContext = createContext<((text: string) => void) | null>(null);

export function useToast(): (text: string) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast outside ToastProvider");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const show = useCallback((text: string) => {
    const id = next.current++;
    // One at a time: the newest replaces the last.
    setItems([{ id, text }]);
    window.setTimeout(() => {
      setItems((all) => all.filter((t) => t.id !== id));
    }, 4000);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pt-safe pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-4"
        data-testid="toasts"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="flex max-w-md items-center gap-2 rounded-full bg-fg px-4 py-2.5 text-sm font-medium text-canvas shadow-2"
          >
            <Icon name="check" size={18} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
