import { useCallback, useEffect, useState } from 'react';
import type { NotCoveredResult } from '../../shared/rules';
import { Panel } from '../components/Panel';
import { NOT_COVERED_TITLE, notCoveredHeaderOf, notCoveredIntro, tickedText } from './choicesModel';

interface NotCoveredCardProps {
  backupId: number;
  /** Inside another card (the phone's card, the report): no frame of its own. */
  framed: boolean;
  /** The list starts open (its own section on a backup's page). */
  open?: boolean;
}

/**
 * "Not covered by this backup": what no backup can copy (authenticator codes, contacts and messages, WhatsApp chats, Signal, app logins),
 * each with one line on what to do and a tick the app remembers for this backup. A closed fold: its summary is the count,
 * "Things no backup can copy: 2 of 5 done"; open it to tick.
 */
export function NotCoveredCard({ backupId, framed, open = false }: NotCoveredCardProps) {
  const [state, setState] = useState<NotCoveredResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((): void => {
    void (async () => {
      try {
        setState(await window.backupHub.rules.notCovered(backupId));
      } catch {
        setState({ ok: false, message: 'This list could not be read.' });
      }
    })();
  }, [backupId]);
  useEffect(load, [load]);

  const tick = (item: string, ticked: boolean): void => {
    setBusy(true);
    void (async () => {
      try {
        setState(await window.backupHub.rules.tickNotCovered({ backupId, item, ticked }));
      } catch {
        setState({ ok: false, message: 'That did not work. Nothing was changed.' });
      }
      setBusy(false);
    })();
  };

  return <NotCoveredView state={state} busy={busy} framed={framed} open={open} onTick={tick} />;
}

interface NotCoveredViewProps {
  /** Null while the list is being read. */
  state: NotCoveredResult | null;
  busy: boolean;
  framed: boolean;
  open?: boolean;
  onTick: (item: string, ticked: boolean) => void;
}

/** The card itself (no data fetching, so it can be drawn and tested on its own). */
export function NotCoveredView({ state, busy, framed, open = false, onTick }: NotCoveredViewProps) {
  const body = (
    <div className="settings-stack">
      {state === null ? <span role="status" className="cell-sub">Reading the list.</span> : null}
      {state !== null && !state.ok ? <span role="alert" className="cell-sub">{state.message}</span> : null}
      {state !== null && state.ok ? (
        <details className="more" {...(open ? { open: true } : {})}>
          <summary>{notCoveredHeaderOf(state)}</summary>
          <div className="settings-stack">
            <span className="cell-sub">{notCoveredIntro}</span>
            {state.items.map((item) => (
              <label key={item.id} className="cell-stack cell-stack--tight">
                <span>
                  <input type="checkbox" checked={item.ticked} disabled={busy} onChange={() => onTick(item.id, !item.ticked)} /> <b>{item.title}</b>
                  {item.ticked ? <span className="cell-sub"> {tickedText(item.tickedAt)}</span> : null}
                </span>
                <span className="cell-sub">{item.howTo}</span>
              </label>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
  return framed ? <Panel title={NOT_COVERED_TITLE} accent="phone">{body}</Panel> : (
    <div className="settings-stack" role="group" aria-label={NOT_COVERED_TITLE}>
      {body}
    </div>
  );
}
