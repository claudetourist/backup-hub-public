/** The words and the small decisions behind the "Needs your decision" cards. Pure. */
import type { DecisionCase } from '../../shared/decisions';
import { formatCount, plural } from '../lib/format';
import { formatDateTime } from '../jobs/jobsModel';

/** How many cases Home shows before "Show N more". */
export const CASES_SHOWN = 5;

/** "Found: Today 14:05". */
export const foundText = (at: number, now: number): string => `Found: ${formatDateTime(at, now)}`;

/** The one count on the badge of "Needs you": cases and the other lines (a stopped job, a full drive) together. */
export const needsYouTotal = (decisionTotal: number, otherLines: number): number => decisionTotal + otherLines;

export const needsYouBadgeLabel = (total: number): string => `${formatCount(total)} ${plural(total, 'thing needs', 'things need')} you`;

/** "Do the same for the other 11 copies" (only where the case says another answer covers more of the same). Null when there is none. */
export function similarText(c: Pick<DecisionCase, 'source' | 'similar'>): string | null {
  if (c.similar <= 0) return null;
  const what = c.source === 'copy_differs' ? plural(c.similar, 'copy', 'copies') : plural(c.similar, 'case', 'cases');
  return `Do the same for the other ${formatCount(c.similar)} ${what}`;
}

/** The cases shown now, and how many are kept back behind "Show N more". */
export function splitCases(cases: readonly DecisionCase[], showAll: boolean, limit = CASES_SHOWN): { shown: DecisionCase[]; hidden: number } {
  if (showAll || cases.length <= limit) return { shown: [...cases], hidden: 0 };
  return { shown: cases.slice(0, limit), hidden: cases.length - limit };
}

export const showMoreText = (hidden: number): string => `Show ${formatCount(hidden)} more`;

/** The cases a run just found, in a report: "Needs your decision (2)". */
export const afterRunTitle = (count: number): string => `Needs your decision (${formatCount(count)})`;
