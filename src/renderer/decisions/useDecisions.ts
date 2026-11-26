import { useCallback, useEffect, useState } from 'react';
import type { DecisionList, DecisionListRequest } from '../../shared/decisions';

/** How often the list is asked for again while a screen shows it (it also reloads when `refreshKey` changes and after every answer). */
export const DECISIONS_POLL_MS = 20_000;

/**
 * The open "Needs your decision" cases. Read only. Keeps the last answer when one call fails. `refreshKey` is anything that means "something may
 * have changed" (the jobs changed, a drive came or went); the timer is cleared when the screen goes away.
 */
export function useDecisions(request: DecisionListRequest, refreshKey: string | number = 0): { list: DecisionList | null; reload: () => void } {
  const [list, setList] = useState<DecisionList | null>(null);
  const [bump, setBump] = useState(0);
  const { backupId, since } = request;
  useEffect(() => {
    let stopped = false;
    const ask = async (): Promise<void> => {
      try {
        const answer = await window.backupHub.decisions.list({ ...(backupId !== undefined ? { backupId } : {}), ...(since !== undefined ? { since } : {}) });
        if (!stopped && answer) setList(answer);
      } catch {
        // Keep what is on screen; the next call tries again.
      }
    };
    void ask();
    const timer = window.setInterval(() => void ask(), DECISIONS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // refreshKey and bump are not read inside: a change of either means "ask again".
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [backupId, since, refreshKey, bump]);
  const reload = useCallback(() => setBump((n) => n + 1), []);
  return { list, reload };
}
