import { useState } from 'react';
import type { PlaceView } from '../../shared/places';
import { Button } from '../components/Button';
import { DeviceDot } from '../components/DeviceDot';
import { IconTile } from '../components/IconTile';
import type { PanelAccent } from '../components/Panel';
import { ProgressBar } from '../components/ProgressBar';
import { CloudIcon, DriveIcon, LaptopIcon, PhoneIcon, StatusAlertIcon, StatusCheckIcon, StatusPlugIcon, UserIcon } from '../icons';
import { OwnerChip } from '../components/OwnerChip';
import { Pill } from '../components/StatusPill';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { isOwnedKind } from '../profiles/profileScope';
import { useOwnerActions } from '../profiles/useOwnerActions';
import { EjectButton } from './EjectButton';
import { SafeToUnplugNote, SafeUnplugButton } from './SafeUnplug';
import { checkNowState, driveSpace, driveStripe, usedShare, type StripeTone } from './devicesModel';
import { lastLookedText, seenConnectedText } from './placesModel';
import type { HealthView } from '../insights/insightsModel';
import { HealthFacts, LoseButton } from '../insights/HealthFacts';

const ICONS: Record<StripeTone, typeof StatusCheckIcon> = {
  ok: StatusCheckIcon,
  amber: StatusAlertIcon,
  crit: StatusAlertIcon,
  neutral: StatusPlugIcon,
};

/** The colour and icon of what a card is of: drives amber, the laptop blue, OneDrive sky, phones violet, Google green. */
const KINDS: Record<PlaceView['kind'], { cat: PanelAccent; icon: typeof DriveIcon }> = {
  drive: { cat: 'drive', icon: DriveIcon },
  laptop: { cat: 'laptop', icon: LaptopIcon },
  onedrive: { cat: 'onedrive', icon: CloudIcon },
  phone: { cat: 'phone', icon: PhoneIcon },
  gdrive: { cat: 'google', icon: UserIcon },
};

/**
 * One drive, the laptop, OneDrive or a phone, as a small card: colour stripe, name, connected or not (icon and word), how full
 * it is, when it was last seen and last checked, and Eject while a drive is plugged in. Management (rename, read-only) is in Settings.
 */
export function PlaceCard({ place, now, health }: { place: PlaceView; now: number; health?: HealthView }) {
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const { profiles } = useProfileScope();
  const { setPlaceOwner } = useOwnerActions();
  const stripe = driveStripe(place);
  const Icon = ICONS[stripe.tone];
  const kind = KINDS[place.kind];
  const word = place.kind === 'laptop' && stripe.tone === 'ok' ? 'This laptop' : stripe.word;
  const space = driveSpace(place);
  const used = usedShare(place.freeBytes, place.capacityBytes);
  const spaceLine = [space.used, space.free, space.total ? `${space.total} in total` : ''].filter((t) => t !== '').join(' · ');
  const listed = place.kind === 'laptop' || place.kind === 'drive' || place.kind === 'onedrive';
  const checked = lastLookedText(place.lastLookedAt, now);
  const checkNow = checkNowState(place);
  // The same action as "Check now" always was: a quick check of the files on this drive or laptop.
  const check = (): void => {
    setCheckMessage(null);
    void (async () => {
      try {
        const result = await window.backupHub.listing.lookAgain(place.id);
        if (!result.ok) setCheckMessage(result.message);
      } catch {
        setCheckMessage('That did not work. Nothing was changed.');
      }
    })();
  };
  return (
    <article className={`device-card device-card--${stripe.tone} cat--${kind.cat}`} aria-label={place.label}>
      <header className="device-card__head">
        <IconTile icon={kind.icon} cat={kind.cat} />
        <b className="device-card__name">
          <DeviceDot name={place.label} />
        </b>
        <Pill tone={stripe.tone}>
          <Icon size={14} /> {word}
        </Pill>
      </header>
      {place.problem ? (
        <span role="alert" className="cell-sub tone-text tone-text--amber">
          {place.problem}
        </span>
      ) : null}
      {used !== null ? (
        <>
          <ProgressBar label={`Space used on ${place.label}`} value={used * 100} tone={stripe.tone} valueText={spaceLine} />
          <span className="cell-sub">{spaceLine}</span>
        </>
      ) : spaceLine ? (
        <span className="cell-sub">{spaceLine}</span>
      ) : null}
      <dl className="device-card__facts">
        <dt>Belongs to</dt>
        <dd>
          <OwnerChip what={place.label} owner={isOwnedKind(place.kind) ? (profiles.find((p) => p.id === place.profileId) ?? null) : null} people={profiles} onChoose={isOwnedKind(place.kind) ? (personId) => void setPlaceOwner(place.id, personId) : undefined} />
        </dd>
        {place.kind === 'laptop' || health?.state === 'ready' ? null : (
          <>
            <dt>Last seen</dt>
            <dd>{seenConnectedText(place, now) || 'Never'}</dd>
          </>
        )}
        {listed ? (
          <>
            <dt>Last checked</dt>
            <dd className={checked.tone === 'amber' ? 'tone-text tone-text--amber' : undefined}>{checked.text}</dd>
          </>
        ) : null}
        {health ? <HealthFacts place={place} health={health} now={now} /> : null}
      </dl>
      <span className="device-card__actions">
        {checkNow.show ? (
          <Button size="sm" variant="secondary" disabled={checkNow.busy} onClick={check}>
            {checkNow.text}
          </Button>
        ) : null}
        {place.kind === 'drive' && place.status === 'connected' ? <EjectButton placeId={place.id} label={place.label} /> : null}
        {place.kind === 'phone' && place.safeToUnplug === true ? <SafeToUnplugNote /> : null}
        {place.kind === 'phone' && place.safeToUnplug !== true && place.status === 'connected' ? <SafeUnplugButton /> : null}
        <LoseButton place={place} />
      </span>
      {checkMessage ? (
        <span className="cell-sub tone-text tone-text--amber" role="status">
          {checkMessage}
        </span>
      ) : null}
    </article>
  );
}
