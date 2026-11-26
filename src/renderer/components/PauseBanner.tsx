import { pauseBanner } from '../../shared/pause';
import { useNow } from '../jobs/useNow';
import { usePause } from '../pause/PauseProvider';
import { Button } from './Button';

/** A thin line on top of every screen while Pause everything is on: when it ends, and a Resume button. */
export function PauseBanner() {
  const { status, choose } = usePause();
  const now = useNow();
  const text = pauseBanner(status, now);
  if (text === null) return null;
  return (
    <div className="pause-banner" role="status">
      <span>{text}</span>
      <Button size="sm" onClick={() => choose('off')}>
        Resume
      </Button>
    </div>
  );
}
