/**
 * The loading state: grey bars where the content will be, and a line saying what is happening ("Reading the phone"),
 * so a wait is never a mystery. Screen readers hear the line.
 */
export function Skeleton({ what, rows = 4 }: { what: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-live="polite">
      <p className="skeleton__what">{what}</p>
      <div className="skeleton__rows" aria-hidden="true">
        {Array.from({ length: rows }, (_unused, index) => (
          <span key={index} className="skeleton__bar" />
        ))}
      </div>
    </div>
  );
}
