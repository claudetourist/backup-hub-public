/**
 * Dev only (compiled out of production builds): "your choices" and the things no backup can copy for the Backups screen in a plain browser
 * (`#/backups?mock`). One choice is already saved (never back up the WhatsApp Business Status folder), two of the five things no backup can
 * copy are ticked. Adding and removing choices and ticking work on this pretend state only; nothing is stored anywhere.
 */
import { NOT_COVERED_ITEMS, draftCovers, ruleWords, storedPattern, type NotCoveredLine, type NotCoveredResult, type NotCoveredTickRequest, type RuleAddRequest, type RuleAddResult, type RuleEffectRequest, type RuleEffectResult, type RuleRemoveRequest, type RuleRemoveResult, type RuleView, type RulesListResult } from '../../shared/rules';
import type { LeftOutGroup, PreviewRow } from '../../shared/phoneBackup';

export const MOCK_SAVED_FOLDER = '/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses';
/** What the saved choice leaves out of the pretend plan. */
const SAVED_LEFT_OUT = { files: 31, bytes: 52_000_000 };
/** The filter groups of the pretend plan, so "Always include" can say how many files it brings back. */
const FILTER_GROUPS: Record<string, { files: number; bytes: number }> = {
  '/sdcard/DCIM/.thumbnails': { files: 1_204, bytes: 310_000_000 },
  '/sdcard/Download': { files: 7, bytes: 1_400_000 },
};

export interface RulesMock {
  handlers: Record<string, unknown>;
  /** The groups the saved "never back up" choices make in the pretend plan. */
  groups(): LeftOutGroup[];
  count(): number;
}

export function createRulesMock(rows: () => readonly PreviewRow[]): RulesMock {
  let nextId = 2;
  const make = (id: number, scope: RuleView['scope'], pattern: string, choice: RuleView['choice'], createdAt: number): RuleView => ({ id, scope, choice, pattern, words: ruleWords({ scope, pattern, choice }), createdAt, everyBackup: false });
  const saved: RuleView[] = [make(1, 'folder', MOCK_SAVED_FOLDER, 'leave_out', Date.UTC(2026, 10, 20, 9))];
  const ticked = new Map<string, number>([
    ['contacts_messages', Date.UTC(2026, 10, 12, 10)],
    ['whatsapp', Date.UTC(2026, 10, 12, 10, 5)],
  ]);

  const notCovered = (): NotCoveredResult => {
    const items = NOT_COVERED_ITEMS.map((i): NotCoveredLine => ({ id: i.id, title: i.title, howTo: i.howTo, ticked: ticked.has(i.id), tickedAt: ticked.get(i.id) ?? null }));
    return { ok: true, backupId: 1, backupName: 'Poco F4', items, done: items.filter((i) => i.ticked).length, total: items.length };
  };

  return {
    count: () => saved.filter((r) => r.choice === 'leave_out').length,
    groups: () =>
      saved
        .filter((r) => r.choice === 'leave_out' && r.id === 1)
        .map((r) => ({ key: `rule:${r.id}`, filter: 'your_rule', folder: r.pattern, files: SAVED_LEFT_OUT.files, bytes: SAVED_LEFT_OUT.bytes, canInclude: false, rule: { id: r.id, words: r.words } })),
    handlers: {
      'rules.list': (): Promise<RulesListResult> => Promise.resolve({ ok: true, backupId: 1, backupName: 'Poco F4', rules: [...saved] }),
      'rules.effect': (request: RuleEffectRequest): Promise<RuleEffectResult> => {
        const none = { files: 0, bytes: 0 };
        if (request.change.kind === 'remove') {
          const gone = saved.find((r) => r.id === (request.change as { ruleId: number }).ruleId);
          if (!gone) return Promise.resolve({ ok: false, message: 'That choice is not on the list any more.' });
          return Promise.resolve({ ok: true, backupName: 'Poco F4', hasPlan: true, leavesOut: none, bringsBack: gone.id === 1 ? SAVED_LEFT_OUT : none });
        }
        const draft = request.change.draft;
        if (draft.choice === 'include') {
          const g = FILTER_GROUPS[draft.pattern];
          return Promise.resolve({ ok: true, backupName: 'Poco F4', hasPlan: true, leavesOut: none, bringsBack: g ?? none });
        }
        const hit = rows().filter((r) => draftCovers(draft, r.path));
        return Promise.resolve({ ok: true, backupName: 'Poco F4', hasPlan: true, leavesOut: { files: hit.length, bytes: hit.reduce((s, r) => s + r.size, 0) }, bringsBack: none });
      },
      'rules.add': (request: RuleAddRequest): Promise<RuleAddResult> => {
        const pattern = storedPattern(request);
        const twin = saved.find((r) => r.scope === request.scope && r.pattern === pattern && r.choice === request.choice);
        const rule = twin ?? make(nextId++, request.scope, pattern, request.choice, Date.now());
        if (!twin) saved.push(rule);
        return Promise.resolve({ ok: true, message: 'Saved. Every later backup of Poco F4 will ' + (request.choice === 'leave_out' ? 'leave this out.' : 'include this.'), rule, count: saved.length, added: !twin });
      },
      'rules.remove': (request: RuleRemoveRequest): Promise<RuleRemoveResult> => {
        const at = saved.findIndex((r) => r.id === request.ruleId);
        if (request.confirmed !== true || at < 0) return Promise.resolve({ ok: false, message: 'That choice is not on the list any more. Nothing was changed.' });
        saved.splice(at, 1);
        return Promise.resolve({ ok: true, message: 'Removed. Nothing was deleted.', count: saved.length });
      },
      'rules.notCovered': (): Promise<NotCoveredResult> => Promise.resolve(notCovered()),
      'rules.tickNotCovered': (request: NotCoveredTickRequest): Promise<NotCoveredResult> => {
        if (request.ticked) ticked.set(request.item, Date.now());
        else ticked.delete(request.item);
        return Promise.resolve(notCovered());
      },
    },
  };
}
