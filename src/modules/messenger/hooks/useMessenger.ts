import { useEffect, useState } from 'react';
import { useMessengerStore } from '../store/messengerStore';
import { getMessengerRuntime, type MessengerRuntime } from '../runtime';

/**
 * React hook for ChatScreen-level access to the messenger runtime.
 * On first mount it triggers lazy runtime init; subsequent callers
 * just get back the memoized singleton once ready. `error` surfaces
 * crypto failures that were thrown out of sendText — callers should
 * show a user-visible error, not silently swallow.
 */
export function useMessenger() {
  const ready = useMessengerStore(s => s.ready);
  const error = useMessengerStore(s => s.error);
  const [runtime, setRuntime] = useState<MessengerRuntime | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMessengerRuntime()
      .then(rt => {
        if (!cancelled) {setRuntime(rt);}
      })
      .catch(e => {
        if (!cancelled) {
          useMessengerStore.getState().setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { runtime, ready: ready && runtime !== null, error };
}
