import type { Tone } from './status';

interface StatTileProps {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
}

/** Big number with a coloured dot + label above and a short explanation below. */
export function StatTile({ label, value, detail, tone = 'neutral' }: StatTileProps) {
  return (
    <div className={`stat-tile stat-tile--${tone}`}>
      <span className="stat-tile__label">
        <span className="stat-tile__dot" aria-hidden="true" />
        {label}
      </span>
      <span className="stat-tile__value">{value}</span>
      {detail ? <span className="stat-tile__detail">{detail}</span> : null}
    </div>
  );
}
