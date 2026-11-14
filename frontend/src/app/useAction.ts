// One-off writes from screens: busy flag, error to show, and a run() that
// ignores a cancelled re-authentication (the person chose not to continue).
import { useCallback, useState } from "react";
import { ReauthCancelled } from "./reauth.tsx";

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await action();
      } catch (e) {
        if (!(e instanceof ReauthCancelled)) setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, error, setError, run };
}
