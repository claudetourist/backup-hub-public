import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultSavedName,
  MAX_INDEXED_ON_SCREEN,
  MAX_SCREEN_RESULTS,
  parseExtensions,
  type SavedSearch,
  type SearchCursor,
  type SearchFacets,
  type SearchHit,
  type SearchIndexStatus,
  type SearchRequest,
  type SearchSort,
  type SortDirection,
} from '../../shared/search';
import { Button } from '../components/Button';
import { WhyLink } from '../why/WhyLink';
import { copyFileRequest } from '../why/whyModel';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { KindBadge } from '../components/KindBadge';
import { PageHeader } from '../components/PageHeader';
import { FolderIcon } from '../icons';
import { Panel } from '../components/Panel';
import { Pill } from '../components/StatusPill';
import { TextField } from '../components/TextField';
import { Toggle } from '../components/Toggle';
import { useNow } from '../jobs/useNow';
import { useNavigate } from '../navContext';
import { useProfileScope, useScopedPlaces } from '../profiles/ProfileScopeProvider';
import { searchPerson } from '../profiles/profileScope';
import { ChangeKind } from '../search/ChangeKind';
import { GetBackBar, tickColumn } from '../search/GetBack';
import { FilterBar } from '../search/FilterBar';
import { initialFilters, type FilterState } from '../search/filterModel';
import { SavedSearchesMenu } from '../search/SavedSearchesMenu';
import { indexLine, screenStateOf } from '../search/savedModel';
import { clearSearchSeed, peekSearchSeed } from '../search/searchSeed';
import {
  appendHits,
  canOpenInDrive,
  canShowMore,
  copiesLabel,
  copiesText,
  copiesTotalText,
  copiesTone,
  dateBounds,
  displayFolder,
  displayPath,
  driveButtonLabel,
  fingerprintNote,
  folderBoxText,
  formatDate,
  headerSort,
  isOfflinePlace,
  lastLookedLine,
  listsFrom,
  needsSearch,
  nextOffset,
  nextSortChoice,
  noMatchText,
  placeChips,
  placeGroups,
  placeIdsFromKey,
  placeIdsKey,
  SEARCH_DEBOUNCE_MS,
  searchLabel,
  showInFolderState,
  showMoreLabel,
  sizeBounds,
  sizeText,
  SORT_OPTIONS,
  countsKeyOf,
  knownTotal,
  summaryText,
  verdictText,
  yearOptions,
} from '../search/searchModel';

type View =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'done'; hits: SearchHit[]; total: number | null; request: SearchRequest; next: SearchCursor | null | undefined }
  | { state: 'failed'; message: string };

const columns: Column<SearchHit>[] = [
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    rowHeader: true,
    render: (hit) => (
      <span className="cell-stack">
        <b className="search-name">{hit.name}</b>
        <span className="cell-sub search-folder">{hit.copies[0] ? displayFolder(hit.folder, hit.copies[0].placeKind) : hit.folder}</span>
      </span>
    ),
  },
  { key: 'kind', header: 'Type', className: 'col-kind', width: 150, render: (hit) => <KindBadge kind={hit.kind} /> },
  { key: 'size', header: 'Size', sortable: true, align: 'end', className: 'col-size', width: 100, render: (hit) => sizeText(hit.size) },
  { key: 'date', header: 'Date', sortable: true, className: 'col-size', width: 120, render: (hit) => formatDate(hit.mtime) },
  {
    key: 'copies',
    header: 'Copies',
    sortable: true,
    width: 170,
    render: (hit) => (
      <Pill tone={copiesTone(hit)}>
        <span className="pill__dot" aria-hidden="true" />
        {copiesLabel(hit)}
      </Pill>
    ),
  },
];

function Details({ hit, onSearchFolder, onKindChanged }: { hit: SearchHit; onSearchFolder: (folder: string) => void; onKindChanged: () => void }) {
  const { snapshot } = useScopedPlaces();
  const places = snapshot?.places ?? [];
  const now = useNow();
  const [message, setMessage] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState<string | null>(null);

  const act = (run: () => Promise<{ ok: boolean; message?: string }>): void => {
    setMessage(null);
    void (async () => {
      try {
        const result = await run();
        if (!result.ok) setMessage(result.message ?? 'That did not work.');
      } catch {
        setMessage('That did not work. Please try again.');
      }
    })();
  };

  return (
    <aside className="panel search-details" aria-label="File details">
      <div className="cell-stack cell-stack--tight">
        <span className="search-details__kind">
          <KindBadge kind={hit.kind} />
          {changing ? null : (
            <Button size="sm" variant="quiet" onClick={() => setChanging(true)}>
              Change category
            </Button>
          )}
        </span>
        {changing ? (
          <ChangeKind
            targets={hit.copies.map((c) => ({ type: 'file' as const, fileId: c.fileId }))}
            similarFrom={hit.copies[0]?.fileId ?? null}
            current={hit.kind}
            onChanged={(text) => {
              setChanging(false);
              setChanged(text);
              onKindChanged();
            }}
            onCancel={() => setChanging(false)}
          />
        ) : null}
        {changed ? (
          <span className="cell-sub" role="status">
            {changed}
          </span>
        ) : null}
        <h2 className="search-details__title">{hit.name}</h2>
        <span className="cell-sub">{[sizeText(hit.size), hit.mtime === null ? '' : `made ${formatDate(hit.mtime)}`].filter((t) => t !== '').join(' · ')}</span>
        <b className={`tone-text tone-text--${copiesTone(hit)}`}>{verdictText(hit)}</b>
      </div>
      <span className="page-header__eyebrow">{copiesTotalText(hit)}</span>
      <ol className="search-copies">
        {placeGroups(hit).map((group, i) => {
          const first = group.copies[0];
          const offline = first ? isOfflinePlace(group.placeId, first.placeKind, places) : false;
          return (
            <li key={group.placeId} className="search-copy">
              <span className="search-copy__n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="cell-stack cell-stack--tight">
                <span className="search-copy__head">
                  <b>{group.label}</b>
                  <span className="cell-sub">
                    {copiesText(group.files)} · {lastLookedLine(group, now)}
                  </span>
                </span>
                {offline ? (
                  <span className="search-copy__offline">
                    <span className="status-dot status-dot--offline" aria-hidden="true" />
                    {group.label} · not connected
                  </span>
                ) : null}
                {group.copies.map((copy) => {
                  const folderState = showInFolderState(copy, places);
                  return (
                    <span key={copy.fileId} className="search-copy__one">
                      <span className="search-copy__path">
                        <span className={`status-dot status-dot--${offline ? 'offline' : 'online'}`} aria-hidden="true" /> {displayPath(copy)}
                      </span>
                      <span className="cell-sub">
                        {copy.verified ? 'Verified copy' : copy.checked ? 'Checksum read' : 'Not checked yet'} · {offline ? 'not connected now' : 'connected'}
                      </span>
                      {copy.cloudOnly ? <span className="cell-sub">Only in the cloud, not stored on this PC</span> : null}
                      <span className="search-copy__actions">
                        <WhyLink request={copyFileRequest(copy.fileId)} name={hit.name} />
                        {folderState.state === 'enabled' ? (
                          <Button size="sm" variant="quiet" onClick={() => act(() => window.backupHub.search.showInFolder(copy.fileId))}>
                            Show in folder
                          </Button>
                        ) : folderState.state === 'disabled' ? (
                          <span title={folderState.reason}>
                            <Button size="sm" variant="quiet" disabled>
                              Show in folder
                            </Button>
                          </span>
                        ) : null}
                        {canOpenInDrive(copy) ? (
                          <Button size="sm" variant="quiet" onClick={() => act(() => window.backupHub.search.openInDrive(copy.fileId))}>
                            {driveButtonLabel(copy)}
                          </Button>
                        ) : null}
                        {folderBoxText(copy) !== '' ? (
                          <Button size="sm" variant="quiet" onClick={() => onSearchFolder(folderBoxText(copy))}>
                            Search in this folder
                          </Button>
                        ) : null}
                      </span>
                    </span>
                  );
                })}
                {group.notListed > 0 ? <span className="cell-sub">and {copiesText(group.notListed)} more here, not listed</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {message ? (
        <p className="tone-text tone-text--crit" role="alert">
          {message}
        </p>
      ) : null}
      <span className="cell-sub">Backups count places: two copies on the same drive fail together. {fingerprintNote(hit)}</span>
    </aside>
  );
}

/** More results can be asked for: with the indexed search while it gave a next cursor; with the plain search a page is asked for by offset. */
function moreAvailable(view: Extract<View, { state: 'done' }>): boolean {
  return view.next === undefined ? true : view.next !== null && view.hits.length < MAX_INDEXED_ON_SCREEN;
}

export default function Search() {
  const { snapshot } = useScopedPlaces();
  const places = useMemo(() => snapshot?.places ?? [], [snapshot]);
  const chips = useMemo(() => placeChips(places), [places]);
  const now = useNow();
  const navigate = useNavigate();

  const [text, setText] = useState('');
  // On for every new visit: most people look for a name that is also a folder name.
  const [includeFolders, setIncludeFolders] = useState(true);
  // Every filter in one value; the quick chips and "More filters" change it (see filterModel).
  const [seed] = useState(peekSearchSeed);
  const [filters, setFilters] = useState<FilterState>(() => initialFilters(seed));
  const { category, kind, onlyOnePlace, unfingerprinted, fewCopies, size, folder, extText, date } = filters;
  const chosenPlaces = filters.places;
  // Goes up after you change a kind, so the results are asked for again.
  const [refresh, setRefresh] = useState(0);
  const [sort, setSort] = useState<SearchSort | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection | null>(null);
  const [view, setView] = useState<View>({ state: 'idle' });
  // True from the moment a search starts until its answer arrives. The rows already on screen stay, dimmed.
  const [pending, setPending] = useState(false);
  // The counts above the results stay on screen while the next search runs, so the chips do not blink.
  const [facets, setFacets] = useState<SearchFacets | null>(null);
  // False from the moment a search starts until its counts arrive: the chips show the old numbers dimmed.
  const [countsFresh, setCountsFresh] = useState(false);
  const [years, setYears] = useState<[number, number] | null>(null);
  // The number of contents from the counts request, for a page that came without one (see knownTotal).
  const [countsTotal, setCountsTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  // The results ticked for "Get files back".
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const resultColumns = useMemo(
    () => [tickColumn(ticked, (key) => setTicked((cur) => { const next = new Set(cur); if (!next.delete(key)) next.add(key); return next; })), ...columns],
    [ticked],
  );
  useEffect(() => clearSearchSeed, []);
  // How ready the search index is, asked every 2 seconds until it is (the answer is kept in memory in main; nothing waits for the database).
  const [indexStatus, setIndexStatus] = useState<SearchIndexStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const ask = (): void => {
      void (async () => {
        try {
          const status = await window.backupHub.search.indexStatus();
          if (!alive || !status) return;
          setIndexStatus(status);
          if (status.available && !status.ready) timer = window.setTimeout(ask, 2000);
        } catch {
          // No line about it; the search itself works.
        }
      })();
    };
    ask();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);
  // Saved searches.
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const answer = await window.backupHub.search.savedList();
        if (answer?.ok) setSaved(answer.saved);
      } catch {
        // The menu simply shows nothing saved.
      }
    })();
  }, []);
  // The height of the results area, so the long list draws only the rows in view.
  const [listHeight, setListHeight] = useState(0);
  const measure = useCallback((element: HTMLDivElement | null): (() => void) | void => {
    if (!element) return undefined;
    const update = (): void => setListHeight(Math.floor(element.clientHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const latest = useRef(0);
  // The search whose numbers are on the chips; clicking a sort does not change it, so those numbers are kept.
  const countsFor = useRef('');
  const countsRefresh = useRef(0);

  // Everything below is a string or a number, so the request is the same object until the person changes something
  // (the place list is sent again every 10 seconds, and that alone must not search again).
  // The person in focus: main (the query worker) keeps to the files of their phones, their Google accounts and the folders their backups save to.
  const { scope } = useProfileScope();
  const person = searchPerson(scope);
  const placesKey = placeIdsKey(chips, chosenPlaces);
  const notInKey = placeIdsKey(chips, filters.notIn);
  const { gone } = filters;
  const { minSize, maxSize } = sizeBounds(size);
  const extKey = parseExtensions(extText).join(' ');
  const { fromDate, toDate } = dateBounds(date);
  const request = useMemo<SearchRequest>(
    () => ({
      text,
      includeFolders,
      category,
      placeIds: placeIdsFromKey(placesKey),
      person,
      fewCopies,
      kind,
      onlyOnePlace,
      unfingerprinted,
      sort,
      minSize,
      maxSize,
      folder,
      extensions: extKey === '' ? [] : extKey.split(' '),
      fromDate,
      toDate,
      sortDir,
      notInPlaceIds: placeIdsFromKey(notInKey),
      gone,
      after: null,
      offset: 0,
      part: 'page',
    }),
    [text, includeFolders, category, placesKey, notInKey, gone, person, fewCopies, kind, onlyOnePlace, unfingerprinted, sort, minSize, maxSize, folder, extKey, fromDate, toDate, sortDir],
  );

  // Ask 300 ms after the last change. A newer question makes the answer to an older one useless: it is ignored here
  // and main stops working on it. Any change starts again at the first page.
  useEffect(() => {
    latest.current += 1;
    const ticket = latest.current;
    if (!needsSearch(request)) return undefined;
    const timer = window.setTimeout(() => {
      // Rows from an earlier search stay (dimmed) until the new ones arrive; only the very first search shows a blank wait.
      setView((v) => (v.state === 'done' ? v : { state: 'searching' }));
      setPending(true);
      setLoadingMore(false);
      setMoreError(null);
      const countsKey = countsKeyOf(request);
      const keepCounts = countsKey === countsFor.current && refresh === countsRefresh.current;
      if (!keepCounts) {
        setCountsFresh(false);
        setCountsTotal(null);
      }
      void (async () => {
        try {
          const response = await window.backupHub.search.run(request);
          if (ticket !== latest.current || response.status === 'superseded') return;
          setPending(false);
          if (response.status === 'failed') {
            setView({ state: 'failed', message: response.message });
            return;
          }
          if (response.status !== 'done') return;
          setView({ state: 'done', hits: response.hits, total: response.total, request, next: response.next });
          // The results are on screen; now the numbers for the chips (a separate request, so nothing waited for it).
          if (keepCounts) return;
          try {
            const counts = await window.backupHub.search.run({ ...request, part: 'counts' });
            if (ticket !== latest.current || counts.status !== 'counts') return;
            setFacets(counts.facets);
            setCountsTotal(counts.total);
            countsFor.current = countsKey;
            countsRefresh.current = refresh;
            if (counts.years) setYears(counts.years);
            setCountsFresh(true);
          } catch {
            // No numbers on the chips; the results are fine.
          }
        } catch {
          if (ticket === latest.current) {
            setPending(false);
            setView({ state: 'failed', message: 'The search did not work. Please try again.' });
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [request, refresh]);

  // "Show next 500": the same request one page further, added under the rows already here (nothing is replaced, so the
  // list keeps its place).
  const loadMore = (): void => {
    if (view.state !== 'done' || loadingMore || !moreAvailable(view)) return;
    const base = view.request;
    const ticket = latest.current;
    setLoadingMore(true);
    setMoreError(null);
    void (async () => {
      try {
        // The indexed search pages by cursor (its answer carries `next`); the plain search pages by offset.
        const response = await window.backupHub.search.run(view.next ? { ...base, after: view.next } : { ...base, offset: nextOffset(view.hits.length) });
        if (ticket !== latest.current || response.status === 'superseded') return;
        setLoadingMore(false);
        if (response.status === 'failed') setMoreError(response.message);
        else if (response.status === 'done') setView((v) => (v.state === 'done' && v.request === base ? { ...v, hits: appendHits(v.hits, response.hits), next: response.next } : v));
      } catch {
        if (ticket === latest.current) {
          setLoadingMore(false);
          setMoreError('The next results did not load. Please try again.');
        }
      }
    })();
  };

  const idle = !needsSearch(request);

  // Saved searches: put a saved one back on the screen (the person in focus stays the screen's own), save the one on screen, remove one.
  const applySaved = (search: SavedSearch): void => {
    const state = screenStateOf(search.request, chips);
    setText(state.text);
    setIncludeFolders(state.includeFolders);
    setFilters(state.filters);
    setSort(state.sort);
    setSortDir(state.sortDir);
    setSavedMessage(null);
  };
  const saveSearch = (name: string): void => {
    void (async () => {
      try {
        const answer = await window.backupHub.search.savedSave(name, { ...request, person: null });
        if (answer?.ok) {
          setSaved(answer.saved);
          setSavedMessage('Saved.');
        } else setSavedMessage(answer?.message ?? 'That did not save.');
      } catch {
        setSavedMessage('That did not save. Please try again.');
      }
    })();
  };
  const removeSaved = (search: SavedSearch): void => {
    void (async () => {
      try {
        const answer = await window.backupHub.search.savedRemove(search.id);
        if (answer?.ok) setSaved(answer.saved);
      } catch {
        setSavedMessage('That did not work. Please try again.');
      }
    })();
  };
  const refreshing = pending && !idle;
  const hits = !idle && view.state === 'done' ? view.hits : [];
  const shownTotal = view.state === 'done' ? knownTotal(view.total, countsTotal) : null;
  const selected = hits.find((h) => h.key === pickedKey) ?? hits[0] ?? null;

  const yearList = yearOptions(years);
  const countsMissing = !idle && view.state === 'done' && countsFresh && facets === null;
  const lists = listsFrom(places, chosenPlaces, now);

  const searchInFolder = (path: string): void => setFilters((f) => ({ ...f, folder: path }));

  // The page is exactly one window high: the controls on top, and the results and the details below, each with its own
  // scroll. So the results always fill the window, and picking a row never hides its details.
  return (
    <div className="search-page">
      <PageHeader icon={FolderIcon} cat="onedrive" eyebrow="Find" title="Files" subtitle="Every copy of every file, with its path. Press Ctrl+K from anywhere." />

      <Panel label="Search">
        <div className="search-controls">
          <div className="search-controls__top">
            <TextField label={searchLabel(places)} value={text} onChange={setText} maxLength={400} autoFocus searchBox />
            <Toggle label="Also match folder names" checked={includeFolders} onChange={setIncludeFolders} />
            <SavedSearchesMenu
              saved={saved}
              canSave={!idle}
              suggestion={defaultSavedName(request)}
              message={savedMessage}
              onApply={applySaved}
              onSave={saveSearch}
              onRemove={removeSaved}
            />
          </div>
          {indexLine(indexStatus) !== null ? (
            <p className="fnote fnote--wrap" role="status">
              {indexLine(indexStatus)}
            </p>
          ) : null}
          <FilterBar filters={filters} onChange={setFilters} chips={chips} facets={facets} years={yearList} />
          {lists.length > 0 ? (
            <p className="fnote fnote--wrap" role="status">
              <span>
                Lists from:{' '}
                {lists.map((item, index) => (
                  <Fragment key={item.placeId}>
                    {index > 0 ? ' · ' : ''}
                    <span className={item.old ? 'tone-text tone-text--amber' : undefined}>{item.text}</span>
                  </Fragment>
                ))}
              </span>
              <Button size="sm" variant="quiet" onClick={() => navigate('devices')}>
                Check in Devices
              </Button>
            </p>
          ) : null}
          {countsMissing ? <span className="cell-sub">Counts are shown for smaller searches.</span> : null}
        </div>
      </Panel>

      {idle || view.state === 'idle' ? (
        <EmptyState title="Find a file">Type part of a file name, or pick a type or a sort, to see where every copy is.</EmptyState>
      ) : view.state === 'failed' ? (
        <EmptyState title="The search did not finish">{view.message}</EmptyState>
      ) : view.state === 'searching' ? (
        <>
          <div className="search-progress" role="progressbar" aria-label="Searching" />
          <EmptyState title="Searching">Looking through your listed files. This can take a few seconds.</EmptyState>
        </>
      ) : view.hits.length === 0 ? (
        <EmptyState title="Nothing found">{noMatchText(view.request)}</EmptyState>
      ) : (
        <div className="search-grid">
          <div className={`search-results${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
            <Panel
              title={summaryText(view.hits.length, shownTotal)}
              accent="onedrive"
              icon={FolderIcon}
              flush
              headerAside={
                <span className="search-sorts" role="group" aria-label="Sort by">
                  <span className="cell-sub">Sort</span>
                  {SORT_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className="chip"
                      aria-pressed={(sort ?? 'name') === option.key}
                      onClick={() => {
                        setSort(option.key);
                        setSortDir(null);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
              }
            >
              {refreshing ? <div className="search-progress" role="progressbar" aria-label="Searching" /> : <div className="search-progress is-idle" aria-hidden="true" />}
              <div className="search-virtual" ref={measure}>
                <DataTable
                  caption="Search results"
                  columns={resultColumns}
                  rows={view.hits}
                  rowKey={(hit) => hit.key}
                  onRowClick={(hit) => setPickedKey(hit.key)}
                  selectedKey={selected?.key ?? null}
                  stickyHeader
                  virtual={{ height: listHeight > 0 ? listHeight : 480, rowHeight: 56 }}
                  onNearEnd={moreAvailable(view) ? loadMore : undefined}
                  sort={headerSort(sort, sortDir)}
                  onSortChange={(key) => {
                    const next = nextSortChoice(sort, sortDir, key as SearchSort);
                    setSort(next.sort);
                    setSortDir(next.sortDir);
                  }}
                />
              </div>
              <GetBackBar hits={view.hits} ticked={ticked} onClear={() => setTicked(new Set())} />
              <div className="search-more">
                {view.next !== undefined ? (
                  view.next === null ? null : view.hits.length >= MAX_INDEXED_ON_SCREEN ? (
                    <span className="cell-sub">{MAX_INDEXED_ON_SCREEN.toLocaleString('en-US')} files are shown. Narrow the search to see more.</span>
                  ) : (
                    <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
                      {loadingMore ? 'Loading' : 'Show more'}
                    </Button>
                  )
                ) : canShowMore(view.hits.length, shownTotal) ? (
                  <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? 'Loading' : showMoreLabel(view.hits.length, shownTotal)}
                  </Button>
                ) : shownTotal !== null && view.hits.length < shownTotal ? (
                  <span className="cell-sub">{MAX_SCREEN_RESULTS.toLocaleString('en-US')} files are shown. Narrow the search to see more.</span>
                ) : null}
                {moreError ? (
                  <span className="tone-text tone-text--crit" role="alert">
                    {moreError}
                  </span>
                ) : null}
              </div>
            </Panel>
          </div>
          {selected ? <Details key={selected.key} hit={selected} onSearchFolder={searchInFolder} onKindChanged={() => setRefresh((n) => n + 1)} /> : null}
        </div>
      )}
    </div>
  );
}
