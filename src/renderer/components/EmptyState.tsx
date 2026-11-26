import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Short line, e.g. "No jobs yet". Optional: the default placeholder has none. */
  title?: string;
  children?: ReactNode;
  /** Usually a Button leading to the one useful next step. */
  action?: ReactNode;
}

export function EmptyState({ title, children = 'Nothing here yet.', action }: EmptyStateProps) {
  return (
    <section className="panel empty-state" aria-label={title ?? 'Status'}>
      {title ? <p className="empty-state__title">{title}</p> : null}
      <p className="empty-state__text">{children}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </section>
  );
}
