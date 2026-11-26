import { Pill } from '../components/StatusPill';
import { StatusAlertIcon, StatusCheckIcon } from '../icons';
import { useNavigate } from '../navContext';
import { Button } from '../components/Button';
import type { PlaceView } from '../../shared/places';
import { canAskLose, checkText, errorsText, LOSE_BUTTON, loseSub, seenText, verdictTone, verdictWord, type HealthView } from './insightsModel';

/** The health lines of a device card: the verdict word, why, what Windows says, the last check of old copies, errors. "Checking..." until main has answered. */
export function HealthFacts({ place, health, now }: { place: PlaceView; health: HealthView; now: number }) {
  if (health.state === 'loading') {
    return (
      <>
        <dt>Health</dt>
        <dd className="cell-sub" role="status">
          Checking…
        </dd>
      </>
    );
  }
  if (health.state === 'failed') {
    return (
      <>
        <dt>Health</dt>
        <dd className="cell-sub" role="status">
          Could not check right now
        </dd>
      </>
    );
  }
  const h = health.byId.get(place.id);
  if (!h) return null;
  const tone = verdictTone(h.verdict);
  const Icon = h.verdict === 'healthy' ? StatusCheckIcon : StatusAlertIcon;
  const disk = place.kind === 'drive' || place.kind === 'laptop';
  const copies = place.kind === 'drive';
  return (
    <>
      <dt>Health</dt>
      <dd>
        <Pill tone={tone}>
          <Icon size={14} /> {verdictWord(h.verdict)}
        </Pill>
        {h.reasons.length > 0 ? (
          <ul className="health-reasons">
            {h.reasons.map((r) => (
              <li key={r} className="cell-sub">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </dd>
      {disk ? (
        <>
          <dt>Disk</dt>
          <dd>{h.smartNote}</dd>
        </>
      ) : null}
      {place.kind !== 'laptop' ? (
        <>
          <dt>Last seen</dt>
          <dd>{seenText(h, now)}</dd>
        </>
      ) : null}
      {copies ? (
        <>
          <dt>Old copies</dt>
          <dd>{checkText(h.lastCheck, now)}</dd>
        </>
      ) : null}
      {disk ? (
        <>
          <dt>Errors</dt>
          <dd>{errorsText(h)}</dd>
        </>
      ) : null}
    </>
  );
}

/** "What would I lose?" for one device: opens the answer screen. */
export function LoseButton({ place }: { place: Pick<PlaceView, 'id' | 'kind' | 'label'> }) {
  const navigate = useNavigate();
  if (!canAskLose(place.kind)) return null;
  return (
    <Button size="sm" variant="secondary" onClick={() => navigate('devices', loseSub(place.id))} title={`The files that have no other checked copy if ${place.label} died`}>
      {LOSE_BUTTON}
    </Button>
  );
}
