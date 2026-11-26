import { coveragePercents, coverageSummary, type CoverageBytes } from './coverage';
import { widthPercentRef } from './sizing';

/** Stacked bar: no backup (red), 1 backup (orange), 2 or more (green). Segments sum to 100%. */
export function CoverageBar({ bytes }: { bytes: CoverageBytes }) {
  const percents = coveragePercents(bytes);
  return (
    <span className="coverage-bar" role="img" aria-label={coverageSummary(percents)}>
      {percents.none > 0 ? <span className="coverage-bar__seg coverage-bar__seg--none" ref={widthPercentRef(percents.none)} /> : null}
      {percents.one > 0 ? <span className="coverage-bar__seg coverage-bar__seg--one" ref={widthPercentRef(percents.one)} /> : null}
      {percents.many > 0 ? <span className="coverage-bar__seg coverage-bar__seg--many" ref={widthPercentRef(percents.many)} /> : null}
    </span>
  );
}

export function CoverageLegend() {
  return (
    <ul className="coverage-legend" aria-label="Bar colours">
      <li>
        <span className="coverage-legend__swatch coverage-bar__seg--none" aria-hidden="true" />
        No backup
      </li>
      <li>
        <span className="coverage-legend__swatch coverage-bar__seg--one" aria-hidden="true" />1 backup
      </li>
      <li>
        <span className="coverage-legend__swatch coverage-bar__seg--many" aria-hidden="true" />2 or more
      </li>
    </ul>
  );
}
