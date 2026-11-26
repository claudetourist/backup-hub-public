import type { ReactNode } from 'react';
import type { Tone } from './status';

export type Severity = Extract<Tone, 'crit' | 'warn' | 'amber' | 'info'>;

const SEVERITY_WORD: Record<Severity, string> = {
  crit: 'Urgent',
  warn: 'Warning',
  amber: 'Notice',
  info: 'Info',
};

interface AttentionRowProps {
  severity: Severity;
  title: string;
  detail?: string;
  /** Normally one Button. */
  action?: ReactNode;
}

/** One "this needs you" line: coloured stripe, headline, detail, action. Use inside AttentionList. */
export function AttentionRow({ severity, title, detail, action }: AttentionRowProps) {
  return (
    <li className={`attention-row attention-row--${severity}`}>
      <span className="attention-row__stripe" aria-hidden="true" />
      <span className="attention-row__text">
        <b className="attention-row__title">
          <span className="sr-only">{SEVERITY_WORD[severity]}: </span>
          {title}
        </b>
        {detail ? <span className="attention-row__detail">{detail}</span> : null}
      </span>
      {action ? <span className="attention-row__action">{action}</span> : null}
    </li>
  );
}

export function AttentionList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="attention-list" aria-label={label}>
      <ul>{children}</ul>
    </section>
  );
}
