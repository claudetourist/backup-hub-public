import { EVERYONE_WORD } from '../../shared/people';
import { ChevronUpDownIcon, UserIcon } from '../icons';
import { useNavigate } from '../navContext';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { scopeLabel } from '../profiles/profileScope';
import { PopupMenu, type MenuItemDef } from './PopupMenu';
import { backgroundColorRef } from './sizing';

/**
 * Top of the sidebar: whose things the screens show. You, the other people in the order they were added, then Everyone last; a last line
 * leads to where a person is added. The choice is remembered between launches.
 */
export function ProfileSwitcher() {
  const navigate = useNavigate();
  const { profiles, scope, setScope } = useProfileScope();
  const shown = profiles.find((p) => p.id === scope) ?? null;
  const items: MenuItemDef[] = [
    ...profiles.map((p) => ({ id: `person-${p.id}`, label: p.name, swatch: p.color, checked: scope === p.id, onSelect: () => setScope(p.id) })),
    { id: 'all', label: EVERYONE_WORD, checked: scope === 'all', onSelect: () => setScope('all') },
    { id: 'add', label: 'Add a person', hint: 'In Settings, People', onSelect: () => navigate('settings', 'people') },
  ];
  return (
    <div className="person-switcher" role="group" aria-label="Person">
      <span className="profile-switcher__title">Person</span>
      <PopupMenu
        className="person-switcher__menu"
        label="Person"
        trigger={
          <>
            {shown ? <span className="profile-dot" ref={backgroundColorRef(shown.color)} aria-hidden="true" /> : <UserIcon size={16} />}
            <span className="person-switcher__name">{scopeLabel(scope, profiles)}</span>
            <ChevronUpDownIcon size={14} />
          </>
        }
        items={items}
      />
      <span className="sr-only" role="status">
        Showing {scopeLabel(scope, profiles)}
      </span>
    </div>
  );
}
