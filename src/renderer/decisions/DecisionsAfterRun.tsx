import { useNow } from '../jobs/useNow';
import { afterRunTitle } from './decisionsModel';
import { DecisionCards } from './DecisionCards';
import { useDecisions } from './useDecisions';

/**
 * At the end of a run's report: the cases of this backup that were found since the run began (a refused look, copies found different). Nothing
 * when there are none. The answers are the same as on Home: the cases are one list.
 */
export function DecisionsAfterRun({ backupId, since }: { backupId: number; since: number }) {
  const { list, reload } = useDecisions({ backupId, since });
  const now = useNow();
  if (!list || list.cases.length === 0) return null;
  return (
    <section className="decision-after" aria-label="Needs your decision">
      <b>{afterRunTitle(list.total)}</b>
      <span className="cell-sub">Nothing was changed for these. Everything else was finished.</span>
      <DecisionCards cases={list.cases} now={now} onAnswered={reload} />
    </section>
  );
}
