import { backupSub } from '../backups/backupListModel';
import { useEffect, useState } from 'react';
import { lastPhones, readPhones } from '../backups/phoneCache';
import type { BackupsOverview } from '../../shared/backups';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import { NeedsYouList } from '../decisions/NeedsYouList';
import { useDecisions } from '../decisions/useDecisions';
import { DeviceDot } from '../components/DeviceDot';
import { IconTile } from '../components/IconTile';
import { PageHeader } from '../components/PageHeader';
import { useJobs } from '../jobs/JobsProvider';
import { useNow } from '../jobs/useNow';
import { DriveIcon, HomeIcon, StatusCheckIcon, StatusPlugIcon, UserIcon } from '../icons';
import { useNavigate } from '../navContext';
import { useProfileScope, useScopedJobs, useScopedPlaces } from '../profiles/ProfileScopeProvider';
import { scopeBackups, scopeDecisions } from '../profiles/profileScope';
import { useSettings } from '../settings/SettingsProvider';
import { driveReminders, homeTiles, needsYou, recentActivity, yourBackups, type HomeTile } from './homeModel';
import { YourBackups } from './YourBackups';
import { useMirrorStatus } from '../backups/useMirrorStatus';
import { HomeLoseCard } from '../insights/HomeLoseCard';

function Tile({ tile }: { tile: HomeTile }) {
  const Icon = tile.connected ? StatusCheckIcon : StatusPlugIcon;
  const cat = tile.kind === 'drive' ? 'drive' : 'google';
  return (
    <li className={`home-tile home-tile--${tile.connected ? 'ok' : 'neutral'} cat--${cat}`}>
      <IconTile icon={tile.kind === 'drive' ? DriveIcon : UserIcon} cat={cat} size="lg" />
      <span className="home-tile__text">
        <b className="home-tile__name">{tile.kind === 'drive' ? <DeviceDot name={tile.name} /> : tile.name}</b>
        {tile.space ? <span className="home-tile__space">{tile.space}</span> : null}
        <span className={`tone-text tone-text--${tile.connected ? 'ok' : 'neutral'}`}>
          <Icon size={14} /> {tile.word}
        </span>
      </span>
    </li>
  );
}

/**
 * Home: is everything safe? Your drives and accounts at a glance, each backup with its one status word, what needs you, and the last
 * few things Backup Hub did.
 */
export default function Home() {
  // Whose things are shown: the person in focus (drives are shared and always shown).
  const { scope } = useProfileScope();
  const { snapshot } = useScopedPlaces();
  const { jobs: allJobs } = useJobs();
  const jobs = useScopedJobs(true);
  const navigate = useNavigate();
  const now = useNow();
  const { settings } = useSettings();
  const places = snapshot?.places ?? [];
  const tiles = homeTiles(places);
  const needs = needsYou(jobs, places, now);
  // One list: the cases of "Needs your decision" first (they have buttons), then the other lines. Reloaded when the jobs or the drives change.
  const decisions = useDecisions({}, `${allJobs.map((j) => `${j.id}:${j.state}`).join(',')}|${places.map((p) => `${p.id}:${p.status}`).join(',')}`);
  const recentJobs = useScopedJobs(false);
  const recent = recentActivity(recentJobs, now);
  // The backups and which phones are plugged in: read when the screen opens and again when a job starts, ends or fails. Never on a timer.
  const [overview, setOverview] = useState<BackupsOverview | null>(null);
  const [phones, setPhones] = useState<ConnectedPhones | null>(() => lastPhones());
  const [backupsFailed, setBackupsFailed] = useState(false);
  const jobsKey = allJobs.map((j) => `${j.id}:${j.state}`).join(',');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await window.backupHub.backups.overview();
        if (alive) {
          setOverview(next);
          setBackupsFailed(false);
        }
      } catch {
        if (alive) setBackupsFailed(true);
      }
      try {
        const next = await readPhones();
        if (alive) setPhones(next);
      } catch {
        if (alive) setPhones(null);
      }
    })();
    return () => {
      alive = false;
    };
    // jobsKey is not read inside: a job that started, ended or failed means "read the backups again".
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [jobsKey]);
  // How far behind each second drive is (counted off the window's thread; the lines say "counting..." until it is there).
  const mirror = useMirrorStatus(jobsKey + '|' + (overview?.backups.length ?? 0));
  const backups = overview ? yourBackups(scopeBackups(overview.backups, scope), phones, now, mirror) : null;
  const myDecisions = decisions.list && overview && scope !== 'all' ? { ...decisions.list, cases: scopeDecisions(decisions.list.cases, overview.backups, scope) } : decisions.list;
  const shownDecisions = myDecisions && scope !== 'all' ? { ...myDecisions, total: myDecisions.cases.length } : myDecisions;
  const reminders = driveReminders(places, settings.driveReminderDays, now);
  return (
    <>
      <PageHeader icon={HomeIcon} eyebrow="Backup Hub" title="Home" />
      <div className="home">
        {tiles.length > 0 ? (
          <ul className="home-tiles" aria-label="Drives and accounts">
            {tiles.map((tile) => (
              <Tile key={tile.id} tile={tile} />
            ))}
          </ul>
        ) : null}

        <YourBackups items={backups} failed={backupsFailed && overview === null} onBackUp={(id) => navigate('backups', backupSub(id, 'backup', true))} />

        <HomeLoseCard places={places} refreshKey={jobsKey} />

        <NeedsYouList decisions={shownDecisions} lines={needs} now={now} onAnswered={decisions.reload} onOpen={(target) => navigate(target)} />

        {reminders.length > 0 ? (
          <section className="home-section" aria-label="Reminders">
            <h2 className="devices-section__title">Reminders</h2>
            <ul className="home-list">
              {reminders.map((item) => (
                <li key={item.key}>
                  <button type="button" className="home-line" onClick={() => navigate('devices')}>
                    <StatusPlugIcon size={14} />
                    <span className="home-line__text">{item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="home-section" aria-label="Last 5 in Activity">
          <h2 className="devices-section__title">Activity</h2>
          {recent.length === 0 ? (
            <p className="cell-sub">Nothing yet</p>
          ) : (
            <ul className="home-list">
              {recent.map((item) => (
                <li key={item.id}>
                  <button type="button" className="home-line" onClick={() => navigate('activity')}>
                    <b className="job-title">{item.title}</b>
                    <span className="cell-sub home-line__text" title={item.line}>
                      {item.line}
                    </span>
                    <span className="cell-sub">{item.when}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
