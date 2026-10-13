import { useCallback, useState } from "react";
import { flushSync } from "react-dom";

/** Paint the spinner before the request starts so the click is obvious. */
export function useImmediatePending() {
  const [pending, setPending] = useState(false);

  const startPending = useCallback(() => {
    flushSync(() => setPending(true));
  }, []);

  const stopPending = useCallback(() => {
    setPending(false);
  }, []);

  return { pending, startPending, stopPending };
}
