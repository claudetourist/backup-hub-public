import { SHARED_WORD, textOn } from '../../shared/people';
import type { ProfileView } from '../../shared/settings';
import { PopupMenu } from './PopupMenu';
import { chipColorsRef } from './sizing';

interface OwnerChipProps {
  /** What the person owns, for the spoken name: "Sam phone", "the backup Poco F4". */
  what: string;
  /** The owner; null = shared (a drive: no owner needed, shown as "Shared"). */
  owner: Pick<ProfileView, 'id' | 'name' | 'color'> | null;
  people: readonly Pick<ProfileView, 'id' | 'name' | 'color'>[];
  /** Called with the chosen person's id (only when it is another person than now). Left out = the chip is not a button. */
  onChoose?: ((personId: number) => void) | undefined;
}

/** The small chip that says whose a backup, phone or Google account is, in the person's own colour. Click: a short menu of people. */
export function OwnerChip({ what, owner, people, onChoose }: OwnerChipProps) {
  // The people are not known yet: nothing is said rather than a wrong word.
  if (onChoose !== undefined && people.length === 0) return null;
  if (owner === null || onChoose === undefined || people.length === 0) {
    return (
      <span className="owner-chip owner-chip--shared" title={owner === null ? 'Shared by everyone' : undefined}>
        {owner === null ? SHARED_WORD : owner.name}
      </span>
    );
  }
  const choose = onChoose;
  return (
    <PopupMenu
      className="owner-chip-menu"
      label={`Whose ${what} is`}
      placement="auto"
      trigger={
        <span className="owner-chip" ref={chipColorsRef(owner.color, textOn(owner.color))} title={`${owner.name}. Click to change whose it is`}>
          {owner.name}
        </span>
      }
      items={people.map((p) => ({ id: `owner-${p.id}`, label: p.name, swatch: p.color, checked: p.id === owner.id, onSelect: () => (p.id === owner.id ? undefined : choose(p.id)) }))}
    />
  );
}
