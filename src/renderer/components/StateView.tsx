import type { ReactNode } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { viewStateOf, type ViewInput } from './viewState';

interface StateViewProps extends ViewInput {
  /** What is happening while it loads ("Reading the phone"). */
  loadingText: string;
  /** One sentence for the empty state, and optionally the one button that helps. */
  emptyTitle: string;
  emptyText: string;
  emptyAction?: ReactNode;
  /** Pressed by "Retry" in the error state. */
  onRetry: () => void;
  /** The loaded view. It stays on screen, dimmed, while a new request runs. */
  children: ReactNode;
}

/**
 * The four states of a screen as one pattern: loading (a skeleton that says what it is doing), empty (one sentence, one button),
 * error (plain words and Retry) and loaded. While new results load the old ones stay, dimmed.
 */
export function StateView({ loading, error, count, loadingText, emptyTitle, emptyText, emptyAction, onRetry, children }: StateViewProps) {
  const { state, reloading } = viewStateOf({ loading, error, count });
  if (state === 'loading') return <Skeleton what={loadingText} />;
  if (state === 'error') {
    return (
      <section className="panel state-error" role="alert" aria-label="Something went wrong">
        <p className="state-error__text">{error}</p>
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
      </section>
    );
  }
  if (state === 'empty') {
    return (
      <EmptyState title={emptyTitle} action={emptyAction}>
        {emptyText}
      </EmptyState>
    );
  }
  return (
    <div className={`state-loaded${reloading ? ' is-dimmed' : ''}`} aria-busy={reloading || undefined}>
      {children}
      {reloading ? (
        <span className="sr-only" role="status">
          Updating
        </span>
      ) : null}
    </div>
  );
}
