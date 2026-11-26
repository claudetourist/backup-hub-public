import { useState } from 'react';
import type { DecisionList } from '../../shared/decisions';
import { Button } from '../components/Button';
import { StatusAlertIcon } from '../icons';
import { NEEDS_YOU_LINKS, NEEDS_YOU_SHOWN, type NeedsYouItem } from '../screens/homeModel';
import { needsYouBadgeLabel, needsYouTotal, showMoreText, splitCases } from './decisionsModel';
import { DecisionCards } from './DecisionCards';

/**
 * Home's "Needs you": ONE list with a count badge. The cases of "Needs your decision" come first (they have buttons), then the other lines
 * (a job that stopped or waits for Continue, a drive that is nearly full, an account to sign in again).
 */
export function NeedsYouList({ decisions, lines, now, onAnswered, onOpen }: { decisions: DecisionList | null; lines: readonly NeedsYouItem[]; now: number; onAnswered: () => void; onOpen: (target: NeedsYouItem['target']) => void }) {
  const [showAll, setShowAll] = useState(false);
  const cases = splitCases(decisions?.cases ?? [], showAll);
  const total = needsYouTotal(decisions?.total ?? 0, lines.length);
  return (
    <section className="home-section" aria-label="Needs you">
      <h2 className="devices-section__title">
        Needs you
        {total > 0 ? (
          <span className="count-badge" role="img" aria-label={needsYouBadgeLabel(total)}>
            {total}
          </span>
        ) : null}
      </h2>
      {cases.shown.length > 0 ? <DecisionCards cases={cases.shown} now={now} onAnswered={onAnswered} /> : null}
      {cases.hidden > 0 ? (
        <Button variant="quiet" size="sm" onClick={() => setShowAll(true)}>
          {showMoreText(cases.hidden)}
        </Button>
      ) : null}
      {total === 0 ? (
        <p className="cell-sub">Nothing needs you</p>
      ) : lines.length === 0 ? null : (
        <ul className="home-list">
          {lines.slice(0, NEEDS_YOU_SHOWN).map((item) => (
            <li key={item.key}>
              <button type="button" className="home-line" onClick={() => onOpen(item.target)}>
                <StatusAlertIcon size={14} />
                <span className="home-line__text">{item.text}</span>
                <span className="home-line__go">{NEEDS_YOU_LINKS[item.target]}</span>
              </button>
            </li>
          ))}
          {lines.length > NEEDS_YOU_SHOWN ? (
            <li>
              <Button variant="quiet" size="sm" onClick={() => onOpen('activity')}>
                and {lines.length - NEEDS_YOU_SHOWN} more
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
