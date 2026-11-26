import { PAUSE_CHOICES, isPauseOn } from '../../shared/pause';
import { PauseIcon } from '../icons';
import { usePause } from '../pause/PauseProvider';
import { PopupMenu, type MenuItemDef } from './PopupMenu';

/** One small control in the sidebar: "Pause everything" with 1 hour, until tomorrow, until I resume. While it is on, the same place says Resume. */
export function PauseControl() {
  const { status, choose } = usePause();
  if (isPauseOn(status)) {
    return (
      <button type="button" className="rail__item rail__item--pause" onClick={() => choose('off')}>
        <PauseIcon size={18} />
        <span>Resume everything</span>
      </button>
    );
  }
  const items: MenuItemDef[] = PAUSE_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, onSelect: () => choose(choice.id) }));
  return <PopupMenu className="rail__menu" label="Pause everything" placement="above" items={items} trigger={<><PauseIcon size={18} /><span>Pause everything</span></>} />;
}
