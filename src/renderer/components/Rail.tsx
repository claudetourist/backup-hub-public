import { MoreIcon, ShieldCheckIcon } from '../icons';
import { menuEntries, type ScreenId } from '../navConfig';
import { sidebarScreens } from '../nav';
import { useNavigate } from '../navContext';
import { formatRoute, type Route } from '../routes';
import { PauseControl } from './PauseControl';
import { PopupMenu, type MenuItemDef } from './PopupMenu';
import { ProfileSwitcher } from './ProfileSwitcher';
import { WorkingIndicator } from './WorkingIndicator';

interface RailProps {
  /** The screen being shown (the address of the window). */
  route: Route;
  onSelect: (id: ScreenId) => void;
  /** Counts shown as a red badge next to a screen, e.g. things that need you on Home. */
  badges?: Partial<Record<ScreenId, number>>;
  /** Jobs that need you or failed lately (shown next to the Activity line at the bottom). */
  jobsBadge?: number;
}

const NO_BADGES: Partial<Record<ScreenId, number>> = {};

/** The menu at the bottom: Settings, Help and Backup Hub's own safety copies. Entries without a screen yet are not shown. */
function RailMenu() {
  const navigate = useNavigate();
  const items: MenuItemDef[] = menuEntries().map((entry) => ({
    id: entry.id,
    label: entry.label,
    onSelect: () => navigate(entry.screen, entry.sub),
  }));
  return <PopupMenu className="rail__menu" label="Settings and more" placement="above" items={items} trigger={<><MoreIcon size={18} /><span>Settings and more</span></>} />;
}

/** The sidebar: logo, person switcher, one entry per screen that exists, the Activity line and the menu at the bottom. */
export function Rail({ route, onSelect, badges = NO_BADGES, jobsBadge = 0 }: RailProps) {
  const navigate = useNavigate();
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail__logo">
        <span className="rail__logo-mark">
          <ShieldCheckIcon size={22} />
        </span>
        <span className="rail__logo-name">Backup Hub</span>
      </div>
      <ProfileSwitcher />
      {sidebarScreens().map(({ id, label, Icon }) => {
        const badge = badges[id] ?? 0;
        return (
          <a
            key={id}
            href={formatRoute(id)}
            className="rail__item"
            aria-current={id === route.screen ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onSelect(id);
            }}
          >
            <Icon size={18} />
            <span>{label}</span>
            {badge > 0 ? (
              <span className="rail__badge">
                <span aria-hidden="true">{badge}</span>
                <span className="sr-only">, {badge} need attention</span>
              </span>
            ) : null}
          </a>
        );
      })}
      <WorkingIndicator onOpen={() => navigate('activity')} badge={jobsBadge} />
      <PauseControl />
      <RailMenu />
    </nav>
  );
}
