import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { DriveIcon, LaptopIcon, PhoneIcon, SourcesIcon, UserIcon } from '../icons';
import { useNow } from '../jobs/useNow';
import { useNavigate, useRoute } from '../navContext';
import { driveOrder } from '../places/devicesModel';
import { AccountsViewSwitch, useAccountsView } from '../places/AccountsViewSwitch';
import { AddGoogleAccount } from '../places/AddGoogleAccount';
import { GoogleAccountsGrid } from '../places/GoogleAccountsGrid';
import { PlaceCard } from '../places/PlaceCard';
import { useDriveHealth } from '../insights/useInsights';
import { losePlaceOf } from '../insights/insightsModel';
import { WouldLoseScreen } from '../insights/WouldLoseScreen';import { useProfileScope, useScopedPlaces } from '../profiles/ProfileScopeProvider';
import { scopeLabel } from '../profiles/profileScope';
import type { ComponentType, ReactNode } from 'react';
import { IconTile } from '../components/IconTile';
import type { PanelAccent } from '../components/Panel';

function Section({ title, icon, cat, aside, children }: { title: string; icon: ComponentType<{ size?: number }>; cat: PanelAccent; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="devices-section" aria-label={title}>
      <h2 className="devices-section__title devices-section__title--tile">
        <IconTile icon={icon} cat={cat} size="sm" />
        {title}
        {aside ? <span className="devices-section__aside">{aside}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * Devices: one page, in this order: drives (plugged in first), this laptop and OneDrive, phones, Google accounts.
 * Renaming, read-only and the rest of the management stay in Settings.
 */
export default function Devices() {
  // "What would I lose?" is a section of Devices: #/devices/lose:<place>.
  const placeId = losePlaceOf(useRoute().sub);
  return placeId === null ? <DevicesPage /> : <WouldLoseScreen placeId={placeId} />;
}

function DevicesPage() {
  // The phones and Google accounts of the person in focus; drives, the laptop and OneDrive are shared and always shown.
  const { snapshot } = useScopedPlaces();
  const { scope, profiles } = useProfileScope();
  const navigate = useNavigate();
  const now = useNow();
  // Health is asked when the page opens and when a drive is plugged in or taken out; the cards say "Checking..." until it is there.
  const health = useDriveHealth((snapshot?.places ?? []).map((p) => p.id + ':' + p.status).join(','));
  const [accountsView, setAccountsView] = useAccountsView();
  const places = snapshot?.places ?? [];
  const drives = driveOrder(places.filter((p) => p.kind === 'drive'));
  const own = places.filter((p) => p.kind === 'laptop' || p.kind === 'onedrive');
  const phones = places.filter((p) => p.kind === 'phone');
  const accounts = places.filter((p) => p.kind === 'gdrive');
  const unnamed = snapshot?.unnamed.length ?? 0;
  return (
    <>
      <PageHeader icon={SourcesIcon} cat="laptop" eyebrow="Where your files live" title="Devices" subtitle="What is plugged in, and how much room is left." />
      <div className="devices">
        <Section title="Drives" icon={DriveIcon} cat="drive">
          {unnamed > 0 ? (
            <p className="cell-sub">
              {unnamed === 1 ? '1 drive plugged in has no name yet.' : `${unnamed} drives plugged in have no name yet.`}{' '}
              <Button variant="quiet" size="sm" onClick={() => navigate('settings', 'drives')}>
                Name it in Settings
              </Button>
            </p>
          ) : null}
          {drives.length === 0 ? (
            <p className="cell-sub">No drive has been named yet.</p>
          ) : (
            <div className="device-grid">
              {drives.map((drive) => (
                <PlaceCard key={drive.id} place={drive} now={now} health={health} />
              ))}
            </div>
          )}
        </Section>
        <Section title="This laptop and OneDrive" icon={LaptopIcon} cat="laptop">
          <div className="device-grid">
            {own.map((place) => (
              <PlaceCard key={place.id} place={place} now={now} health={health} />
            ))}
          </div>
        </Section>
        <Section title="Phones" icon={PhoneIcon} cat="phone">
          {phones.length === 0 ? (
            <p className="cell-sub">{scope === 'all' ? 'No phone connected' : `No phone for ${scopeLabel(scope, profiles)} yet`}</p>
          ) : (
            <div className="device-grid">
              {phones.map((phone) => (
                <PlaceCard key={phone.id} place={phone} now={now} health={health} />
              ))}
            </div>
          )}
        </Section>
        <Section title="Google accounts" icon={UserIcon} cat="google" aside={accounts.length > 0 ? <AccountsViewSwitch view={accountsView} onChange={setAccountsView} /> : null}>
          <GoogleAccountsGrid accounts={accounts} now={now} view={accountsView} />
          <AddGoogleAccount />
        </Section>
      </div>
    </>
  );
}
