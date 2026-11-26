import { checkLabel } from '../../shared/places';
import { ownerChangedText, paletteColor, PERSON_COLORS, removeBlockedMessage, type OwnerResult } from '../../shared/people';
import type { ProfileResult, ProfileView } from '../../shared/settings';
import type { Db } from '../db';

/** Colours handed out to new people in turn (the first is the seeded "You" colour). */
export const PROFILE_COLORS = PERSON_COLORS;

interface ProfileRow {
  id: number;
  name: string;
  color: string;
  created_at: number;
  place_count: number;
  backups: number;
  phones: number;
  accounts: number;
}

const OWN_PLACE_KINDS = "('phone', 'gdrive')";

/**
 * The people of the household (table `profiles`). Every backup, phone and Google account belongs to one person; drives, the laptop and
 * OneDrive are shared. Changing an owner changes the database only: nothing on a drive is moved or renamed.
 */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ProfileView[] {
    const first = this.firstId();
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.color, p.created_at,
                (SELECT count(*) FROM places pl WHERE pl.profile_id = p.id) AS place_count,
                (SELECT count(*) FROM backup_profiles b WHERE b.person_id = p.id) AS backups,
                (SELECT count(*) FROM places pl WHERE pl.profile_id = p.id AND pl.kind = 'phone') AS phones,
                (SELECT count(*) FROM places pl WHERE pl.profile_id = p.id AND pl.kind = 'gdrive') AS accounts
         FROM profiles p ORDER BY p.id`,
      )
      .all() as ProfileRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.created_at,
      placeCount: r.place_count,
      backups: r.backups,
      phones: r.phones,
      accounts: r.accounts,
      isFirst: r.id === first,
    }));
  }

  private firstId(): number | null {
    return (this.db.prepare('SELECT min(id) FROM profiles').pluck().get() as number | null) ?? null;
  }

  private findByName(name: string): { id: number } | undefined {
    return this.db.prepare('SELECT id FROM profiles WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
  }

  create(rawName: unknown, rawColor?: unknown): ProfileResult {
    const name = checkLabel(rawName, 'name');
    if (!name.ok) return { ok: false, message: name.message };
    if (this.findByName(name.value)) return { ok: false, message: `There is already someone called ${name.value}.` };
    let color: string;
    if (rawColor === undefined || rawColor === null) {
      const count = (this.db.prepare('SELECT count(*) AS n FROM profiles').get() as { n: number }).n;
      color = PROFILE_COLORS[count % PROFILE_COLORS.length] ?? PROFILE_COLORS[0]!;
    } else {
      const chosen = paletteColor(rawColor);
      if (chosen === null) return { ok: false, message: 'Please pick one of the colours shown.' };
      color = chosen;
    }
    this.db.prepare('INSERT INTO profiles (name, color, created_at) VALUES (?, ?, ?)').run(name.value, color, this.now());
    return { ok: true, profiles: this.list() };
  }

  rename(id: number, rawName: unknown): ProfileResult {
    const name = checkLabel(rawName, 'name');
    if (!name.ok) return { ok: false, message: name.message };
    if (!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id)) {
      return { ok: false, message: 'That person no longer exists.' };
    }
    const clash = this.findByName(name.value);
    if (clash && clash.id !== id) return { ok: false, message: `There is already someone called ${name.value}.` };
    this.db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name.value, id);
    return { ok: true, profiles: this.list() };
  }

  /**
   * Remove a person. The user's rule is "always ask before deleting", so `confirmed` must be true (the UI asks first). Refused, with the
   * reason in plain words, for the first person ("You"), and for anyone who still owns a backup, a phone or a Google account: nothing is
   * ever re-assigned or removed behind the user's back.
   */
  delete(id: number, confirmed: unknown): ProfileResult {
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was removed.' };
    const row = this.db.prepare('SELECT name FROM profiles WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) return { ok: false, message: 'That person no longer exists.' };
    if (id === this.firstId()) return { ok: false, message: `${row.name} cannot be removed: the app needs at least one person. Nothing was removed.` };
    const one = (sql: string): number => this.db.prepare(sql).pluck().get(id) as number;
    const owned = {
      backups: one('SELECT count(*) FROM backup_profiles WHERE person_id = ?'),
      phones: one("SELECT count(*) FROM places WHERE profile_id = ? AND kind = 'phone'"),
      accounts: one("SELECT count(*) FROM places WHERE profile_id = ? AND kind = 'gdrive'"),
    };
    const blocked = removeBlockedMessage(row.name, owned);
    if (blocked !== null) return { ok: false, message: blocked };
    const others = one(`SELECT count(*) FROM places WHERE profile_id = ? AND kind NOT IN ${OWN_PLACE_KINDS}`);
    if (others > 0) return { ok: false, message: `${row.name} still has ${others} ${others === 1 ? 'drive or folder' : 'drives or folders'} on their name. Nothing was removed.` };
    const collections = one('SELECT count(*) FROM collections WHERE profile_id = ?');
    if (collections > 0) return { ok: false, message: `${row.name} still has ${collections} ${collections === 1 ? 'collection' : 'collections'}. Nothing was removed.` };
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    return { ok: true, profiles: this.list() };
  }

  /** Give a backup to a person. Its own phone (when it has one) goes with it, so the backup and the phone never disagree. Database only. */
  setBackupOwner(backupId: unknown, personId: unknown): OwnerResult {
    if (typeof backupId !== 'number' || typeof personId !== 'number') return { ok: false, message: 'That is not a valid request. Nothing was changed.' };
    const backup = this.db.prepare('SELECT id, name, person_id, source_place_id FROM backup_profiles WHERE id = ?').get(backupId) as { id: number; name: string; person_id: number; source_place_id: string | null } | undefined;
    if (!backup) return { ok: false, message: 'That backup no longer exists. Nothing was changed.' };
    const person = this.db.prepare('SELECT name FROM profiles WHERE id = ?').get(personId) as { name: string } | undefined;
    if (!person) return { ok: false, message: 'That person no longer exists. Nothing was changed.' };
    if (backup.person_id === personId) return { ok: true, message: ownerChangedText(backup.name, person.name) };
    if (this.db.prepare('SELECT 1 FROM backup_profiles WHERE person_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(personId, backup.name, backupId)) {
      return { ok: false, message: `${person.name} already has a backup called ${backup.name}. Nothing was changed.` };
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE backup_profiles SET person_id = ? WHERE id = ?').run(personId, backupId);
      if (backup.source_place_id !== null) this.db.prepare("UPDATE places SET profile_id = ? WHERE id = ? AND kind = 'phone'").run(personId, backup.source_place_id);
    })();
    return { ok: true, message: ownerChangedText(backup.name, person.name) };
  }

  /** Give a phone or a Google account to a person (a phone's own backups go with it). Drives, the laptop and OneDrive are shared and are refused. */
  setPlaceOwner(placeId: unknown, personId: unknown): OwnerResult {
    if (typeof placeId !== 'string' || typeof personId !== 'number') return { ok: false, message: 'That is not a valid request. Nothing was changed.' };
    const place = this.db.prepare('SELECT id, kind, label, profile_id FROM places WHERE id = ?').get(placeId) as { id: string; kind: string; label: string; profile_id: number } | undefined;
    if (!place) return { ok: false, message: 'That device no longer exists. Nothing was changed.' };
    if (place.kind !== 'phone' && place.kind !== 'gdrive') return { ok: false, message: `${place.label} is shared by everyone. Nothing was changed.` };
    const person = this.db.prepare('SELECT name FROM profiles WHERE id = ?').get(personId) as { name: string } | undefined;
    if (!person) return { ok: false, message: 'That person no longer exists. Nothing was changed.' };
    if (place.profile_id === personId) return { ok: true, message: ownerChangedText(place.label, person.name) };
    const backups = place.kind === 'phone' ? (this.db.prepare('SELECT id, name FROM backup_profiles WHERE source_place_id = ?').all(placeId) as { id: number; name: string }[]) : [];
    for (const b of backups) {
      if (this.db.prepare('SELECT 1 FROM backup_profiles WHERE person_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(personId, b.name, b.id)) {
        return { ok: false, message: `${person.name} already has a backup called ${b.name}. Nothing was changed.` };
      }
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE places SET profile_id = ? WHERE id = ?').run(personId, placeId);
      for (const b of backups) this.db.prepare('UPDATE backup_profiles SET person_id = ? WHERE id = ?').run(personId, b.id);
    })();
    return { ok: true, message: ownerChangedText(place.label, person.name) };
  }
}
