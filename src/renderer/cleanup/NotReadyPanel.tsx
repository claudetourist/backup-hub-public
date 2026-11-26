import { Panel } from '../components/Panel';
import { NOT_READY_TEXT, NOT_READY_TITLE } from './cleanupModel';

/** Shown at the top of Free up phone space while the second drive is not available: nothing can be removed, and nothing is changed. */
export function NotReadyPanel() {
  return (
    <Panel title={NOT_READY_TITLE}>
      <p role="status">{NOT_READY_TEXT}</p>
    </Panel>
  );
}
