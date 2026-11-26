import { useState } from 'react';
import type { WhyRequest } from '../../shared/decisions';
import { WhyDrawer } from './WhyDrawer';
import { WHY_LINK_TEXT, whyLinkLabel } from './whyModel';

/**
 * The "Why?" link of a row: it opens the drawer that explains the file. Its click and keys stay inside it (a row of the file list ticks
 * on a click; this must not). The request is kept as it was when the link was pressed, so the drawer reads the file once.
 */
export function WhyLink({ request, name }: { request: WhyRequest; name: string }) {
  const [opened, setOpened] = useState<WhyRequest | null>(null);
  return (
    <span className="why-link" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <button type="button" className="why__link" aria-label={whyLinkLabel(name)} aria-haspopup="dialog" onClick={() => setOpened(request)}>
        {WHY_LINK_TEXT}
      </button>
      {opened !== null ? <WhyDrawer request={opened} name={name} onClose={() => setOpened(null)} /> : null}
    </span>
  );
}
