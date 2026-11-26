import type { ReactNode } from 'react';
import { Panel, type PanelAccent } from '../components/Panel';

/** A card with a title on the old screen; on a backup's page (embedded) just the content: the page title already says which backup it is. */
export function Frame({ embedded, title, accent, children }: { embedded: boolean; title: string; accent: PanelAccent; children: ReactNode }) {
  return embedded ? <>{children}</> : <Panel title={title} accent={accent}>{children}</Panel>;
}
