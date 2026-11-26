import { useEffect, useState } from 'react';
import type { WhyRequest, WhyResult } from '../../shared/decisions';
import { Drawer } from '../components/Drawer';
import { toneClass, toneWord, WHY_FAILED, WHY_LOADING, WHY_SUBTITLE, whyTitle } from './whyModel';

/** What the drawer says for an answer (or for no answer yet, or a call that failed). */
export function WhyView({ result, failed = false }: { result: WhyResult | null; failed?: boolean }) {
  if (failed || (result !== null && !result.ok)) {
    return (
      <p role="alert" className="cell-sub">
        {result !== null && !result.ok ? result.message : WHY_FAILED}
      </p>
    );
  }
  if (result === null) {
    return (
      <p role="status" className="cell-sub">
        {WHY_LOADING}
      </p>
    );
  }
  return (
    <div className="why">
      {result.sections.map((section) => (
        <section key={section.title} className="why__section" aria-label={section.title}>
          <h3 className="why__title">{section.title}</h3>
          <ul className="why__lines">
            {section.lines.map((line, i) => (
              // The lines of one section have no id of their own and never change order while the drawer is open.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={i} className={`why__line ${toneClass(line.tone)}`}>
                {toneWord(line.tone) ? <span className="sr-only">{toneWord(line.tone)}</span> : null}
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The explanation of one file, read from main when the drawer opens (read only). */
export function WhyDrawer({ request, name, onClose }: { request: WhyRequest; name: string; onClose: () => void }) {
  const [result, setResult] = useState<WhyResult | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const answer = await window.backupHub.why.file(request);
        if (!stopped) setResult(answer);
      } catch {
        if (!stopped) setFailed(true);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [request]);
  return (
    <Drawer title={whyTitle(result?.ok ? result.name : name)} subtitle={result?.ok ? result.headline : WHY_SUBTITLE} onClose={onClose}>
      <WhyView result={result} failed={failed} />
    </Drawer>
  );
}
