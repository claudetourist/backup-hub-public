import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, so render stays pure but "10:42" and "Yesterday" stay right. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
