import { PageHeader } from '../components/PageHeader';
import { JobsIcon } from '../icons';
import { JobsDrawer } from '../jobs/JobsDrawer';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { scopeLabel } from '../profiles/profileScope';

/** Activity: what is running and what finished, each with its log. Of the person in focus (jobs that belong to no one, such as a drive check, show under Everyone). */
export default function Activity() {
  const { scope, profiles } = useProfileScope();
  return (
    <>
      <PageHeader icon={JobsIcon} cat="person" eyebrow="Work" title="Activity" subtitle={scope === 'all' ? 'Everything running, waiting for you, or finished.' : `What is running, waiting or finished for ${scopeLabel(scope, profiles)}.`} />
      <JobsDrawer />
    </>
  );
}
