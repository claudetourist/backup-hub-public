import { useCallback, useEffect, useState } from 'react';
import type { RuleView, RulesListResult } from '../../shared/rules';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { useToast } from '../components/Toast';
import { BACK_IN_LINE, exclusionLine, NOTHING_EXCLUDED, undoLabel, yourChoicesTitle } from './choicesModel';

interface YourChoicesDrawerProps {
  backupId: number;
  backupName: string;
  onClose: () => void;
  /** Called after a choice was taken back, with how many are left (the list of backups shows the number). */
  onChanged: (count: number) => void;
}

/**
 * "Exclusions" of one backup in a Drawer: one compact list, a line per exclusion (File, Folder or Type, its name, where it is, the date it was
 * added) with Undo. Undo takes effect at once: it deletes nothing, it only means the next backup offers the files again. The "Always include"
 * choices are in a small section below.
 */
export function YourChoicesDrawer({ backupId, backupName, onClose, onChanged }: YourChoicesDrawerProps) {
  const { list, message, undo } = useChoices(backupId, onChanged);
  return (
    <Drawer title={yourChoicesTitle(backupName)} subtitle="Files, folders and kinds of file this backup never copies." onClose={onClose} footer={<Button variant="quiet" onClick={onClose}>Close</Button>}>
      <ChoicesList list={list} message={message} onUndo={undo} />
    </Drawer>
  );
}

/** The Exclusions of this backup on its page (no drawer): the same list, with Undo. */
export function YourChoicesPanel({ backupId, onChanged }: { backupId: number; onChanged: (count: number) => void }) {
  const { list, message, undo } = useChoices(backupId, onChanged);
  return (
    <div className="settings-stack">
      <span className="cell-sub">Files, folders and kinds of file this backup never copies. Undo puts one back: nothing is deleted.</span>
      <ChoicesList list={list} message={message} onUndo={undo} />
    </div>
  );
}

/** Reads the exclusions of one backup and takes one back (Undo). */
function useChoices(backupId: number, onChanged: (count: number) => void) {
  const [list, setList] = useState<RulesListResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback((): void => {
    void (async () => {
      try {
        setList(await window.backupHub.rules.list(backupId));
      } catch {
        setList({ ok: false, message: 'Your exclusions could not be read.' });
      }
    })();
  }, [backupId]);
  useEffect(load, [load]);

  const undo = (rule: RuleView): void => {
    setMessage(null);
    void (async () => {
      try {
        // An explicit click on Undo is the confirmation: nothing is deleted anywhere.
        const result = await window.backupHub.rules.remove({ backupId, ruleId: rule.id, confirmed: true });
        if (result.ok) {
          toast.show({ tone: 'ok', text: rule.choice === 'leave_out' ? BACK_IN_LINE : result.message });
          onChanged(result.count);
        } else setMessage(result.message);
      } catch {
        setMessage('That did not work. Nothing was changed.');
      }
      load();
    })();
  };

  return { list, message, undo };
}

interface ChoicesListProps {
  /** Null while the list is being read. */
  list: RulesListResult | null;
  message: string | null;
  onUndo: (rule: RuleView) => void;
}

function Line({ rule, onUndo }: { rule: RuleView; onUndo: (rule: RuleView) => void }) {
  const line = exclusionLine(rule);
  return (
    <div className="exclusion-line" role="group" aria-label={rule.words}>
      <span className="exclusion-line__kind">{line.kind}</span>
      <span className="phone-file exclusion-line__what" title={rule.words}>
        <b className="phone-file__name">{line.name}</b>
        <span className="phone-file__folder">
          {line.where}
          {rule.everyBackup ? ' · every backup' : ''}
        </span>
      </span>
      <span className="exclusion-line__date">{line.added}</span>
      <Button variant="quiet" size="sm" title={rule.words} onClick={() => onUndo(rule)}>
        {undoLabel(rule)}
      </Button>
    </div>
  );
}

/** The list inside the drawer (no data fetching, so it can be drawn and tested on its own). */
export function ChoicesList({ list, message, onUndo }: ChoicesListProps) {
  const exclusions = list !== null && list.ok ? list.rules.filter((r) => r.choice === 'leave_out') : [];
  const includes = list !== null && list.ok ? list.rules.filter((r) => r.choice === 'include') : [];
  return (
    <div className="settings-stack">
      {list === null ? (
        <span role="status" className="cell-sub">
          Reading your exclusions.
        </span>
      ) : null}
      {list !== null && !list.ok ? (
        <span role="alert" className="cell-sub">
          {list.message}
        </span>
      ) : null}
      {list !== null && list.ok && exclusions.length === 0 ? <span className="cell-sub">{NOTHING_EXCLUDED}</span> : null}
      {exclusions.map((rule) => (
        <Line key={rule.id} rule={rule} onUndo={onUndo} />
      ))}
      {includes.length > 0 ? (
        <div className="settings-stack" role="group" aria-label="Always include">
          <b>Always include</b>
          {includes.map((rule) => (
            <Line key={rule.id} rule={rule} onUndo={onUndo} />
          ))}
        </div>
      ) : null}
      {message ? (
        <span role="status" className="cell-sub">
          {message}
        </span>
      ) : null}
    </div>
  );
}
