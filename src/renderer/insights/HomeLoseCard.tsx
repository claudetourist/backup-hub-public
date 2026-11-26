import { DeviceDot } from '../components/DeviceDot';
import { Button } from '../components/Button';
import { StatusAlertIcon } from '../icons';
import { useNavigate } from '../navContext';
import type { PlaceView } from '../../shared/places';
import { homeLoseItems, LOSE_BUTTON, loseSub } from './insightsModel';
import { useOnlyHere } from './useInsights';

/**
 * Home: shown only when a named drive holds files that have no other checked copy anywhere. Nothing is shown while it is counted (main counts
 * off the window's thread) and nothing when every file has a second copy. Read only; the button opens the full answer in Devices.
 */
export function HomeLoseCard({ places, refreshKey }: { places: readonly PlaceView[]; refreshKey: string }) {
  const navigate = useNavigate();
  const items = homeLoseItems(places, useOnlyHere(refreshKey));
  if (items.length === 0) return null;
  return (
    <section className="home-section" aria-label="Files with no second copy">
      <h2 className="devices-section__title">Files with no second copy</h2>
      <ul className="home-list">
        {items.map((item) => (
          <li key={item.placeId} className="home-line home-line--static">
            <StatusAlertIcon size={14} />
            <span className="home-line__text">
              <DeviceDot name={item.label} /> <span className="cell-sub">{item.text}</span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => navigate('devices', loseSub(item.placeId))}>
              {LOSE_BUTTON}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
