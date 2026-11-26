import { useState } from 'react';
import { CleanupLog } from '../cleanup/CleanupLog';
import { LaptopCleanPanel } from '../cleanup/LaptopCleanPanel';
import { Panel } from '../components/Panel';
import { CleanUpIcon, JobsIcon, ShieldCheckIcon } from '../icons';
import { BackupHubItselfPanel } from './BackupHubItself';
import { useSectionOpen } from '../lib/sectionState';

/** Settings > Tools: the older helpers that are not part of everyday use. Each one asks before it changes anything. */
export function ToolsSection() {
  const [logKey, setLogKey] = useState(0);
  const [dupOpen, toggleDup] = useSectionOpen('tools.duplicates', false);
  const [ownOpen, toggleOwn] = useSectionOpen('tools.own', false);
  return (
    <>
      <Panel title="Find duplicate files on the laptop" accent="drive" icon={CleanUpIcon} collapse={{ open: dupOpen, onToggle: toggleDup, summary: 'Moves extra copies to a safe folder, never deletes' }}>
        <LaptopCleanPanel onStarted={() => setLogKey((k) => k + 1)} />
      </Panel>
      <Panel title="Backup Hub's own safety copies" accent="google" icon={ShieldCheckIcon} collapse={{ open: ownOpen, onToggle: toggleOwn, summary: 'Saved copies of the index, restore, recovery copy' }}>
        <BackupHubItselfPanel />
      </Panel>
      <Panel title="What these tools removed or moved" accent="person" icon={JobsIcon}>
        <CleanupLog key={logKey} />
      </Panel>
    </>
  );
}
