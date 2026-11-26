import { useState } from 'react';
import type { SearchFacets } from '../../shared/search';
import { Button } from '../components/Button';
import { FilterMenu } from '../components/FilterMenu';
import { CategoryDot } from '../components/KindBadge';
import { Toggle } from '../components/Toggle';
import {
  activeFilters,
  applyDraft,
  editDraft,
  isDirty,
  openStaged,
  QUICK_FILTERS,
  isQuickOn,
  removeFilter,
  sameFilters,
  toggleQuick,
  NO_FILTERS,
  type FilterState,
} from './filterModel';
import {
  categoryCount,
  CATEGORY_OPTIONS,
  chooseCategory,
  chooseKind,
  countText,
  KIND_OPTIONS,
  placeCount,
  SIZE_CHOICES,
  SIZE_UNITS,
  type PlaceChip,
  type SizeUnit,
} from './searchModel';

const THIS_YEAR = new Date().getFullYear();

interface DraftProps {
  draft: FilterState;
  edit: (patch: Partial<FilterState>) => void;
}

/** The detailed filters, as plain controls (no pop-ups inside the pop-up). */
function Details({ draft, edit, chips, facets, years }: DraftProps & { chips: readonly PlaceChip[]; facets: SearchFacets | null; years: readonly number[] }) {
  const typeValue = draft.kind !== null ? `kind:${draft.kind}` : draft.category !== null ? `cat:${draft.category}` : '';
  const { date, size } = draft;
  return (
    <>
      <label className="more-filters__row">
        <span className="fbar__label">Type</span>
        <select
          className="fsmall"
          value={typeValue}
          onChange={(event) => {
            const [type, key = ''] = event.target.value.split(':');
            if (type === 'kind') edit(chooseKind(key as NonNullable<FilterState['kind']>));
            else if (type === 'cat') edit(chooseCategory({ category: null, kind: null }, key as NonNullable<FilterState['category']>));
            else edit({ category: null, kind: null });
          }}
        >
          <option value="">All types</option>
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.key} value={`cat:${option.key}`}>
              {option.label}
              {facets ? ` (${countText(categoryCount(facets, option.key))})` : ''}
            </option>
          ))}
          <optgroup label="Finer kinds">
            {KIND_OPTIONS.map((option) => (
              <option key={option.key} value={`kind:${option.key}`}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      {chips.length > 0 ? (
        <div className="more-filters__row more-filters__row--wrap" role="group" aria-label="Where">
          <span className="fbar__label">Where</span>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="fchip"
              aria-pressed={draft.places.has(chip.id)}
              onClick={() => {
                const places = new Set(draft.places);
                if (places.has(chip.id)) places.delete(chip.id);
                else places.add(chip.id);
                edit({ places });
              }}
            >
              {chip.label}
              {chip.connected ? null : <span className="sr-only"> (not connected)</span>}
              {facets ? <span className="chip__count">{countText(placeCount(facets, chip))}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {chips.length > 0 ? (
        <div className="more-filters__row more-filters__row--wrap" role="group" aria-label="Not on">
          <span className="fbar__label">Not on</span>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="fchip"
              aria-pressed={draft.notIn.has(chip.id)}
              onClick={() => {
                const notIn = new Set(draft.notIn);
                if (notIn.has(chip.id)) notIn.delete(chip.id);
                else notIn.add(chip.id);
                edit({ notIn });
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      <label className="more-filters__row">
        <span className="fbar__label">Size</span>
        <select className="fsmall" value={size.mode} onChange={(event) => edit({ size: { ...size, mode: event.target.value as typeof size.mode } })}>
          {SIZE_CHOICES.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {size.mode === 'custom' ? (
        <div className="more-filters__row">
          <input className="fsmall" aria-label="Smallest size" placeholder="At least" value={size.min} maxLength={14} onChange={(e) => edit({ size: { ...size, min: e.target.value } })} />
          <input className="fsmall" aria-label="Biggest size" placeholder="At most" value={size.max} maxLength={14} onChange={(e) => edit({ size: { ...size, max: e.target.value } })} />
          <select className="fsmall" aria-label="Unit for both boxes" value={size.unit} onChange={(e) => edit({ size: { ...size, unit: e.target.value as SizeUnit } })}>
            {SIZE_UNITS.map((u) => (
              <option key={u.key} value={u.key}>
                {u.key}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <label className="more-filters__row">
        <span className="fbar__label">When</span>
        <select
          className="fsmall"
          value={date.mode}
          onChange={(event) => {
            const mode = event.target.value as typeof date.mode;
            edit({ date: { ...date, mode, year: mode === 'year' && date.year === '' ? String(years[0] ?? THIS_YEAR) : date.year } });
          }}
        >
          <option value="any">Any time</option>
          <option value="thisYear">This year</option>
          <option value="lastYear">Last year</option>
          <option value="year">One year...</option>
          <option value="range">From - to...</option>
        </select>
      </label>
      {date.mode === 'year' ? (
        <div className="more-filters__row">
          {years.length > 0 ? (
            <select className="fsmall" aria-label="Year" value={date.year} onChange={(e) => edit({ date: { ...date, year: e.target.value } })}>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          ) : (
            <input className="fsmall" aria-label="Year" inputMode="numeric" maxLength={4} value={date.year} onChange={(e) => edit({ date: { ...date, year: e.target.value } })} />
          )}
        </div>
      ) : null}
      {date.mode === 'range' ? (
        <div className="more-filters__row">
          <input className="fsmall" type="date" aria-label="From day" value={date.from} onChange={(e) => edit({ date: { ...date, from: e.target.value } })} />
          <input className="fsmall" type="date" aria-label="To day" value={date.to} onChange={(e) => edit({ date: { ...date, to: e.target.value } })} />
        </div>
      ) : null}

      <label className="more-filters__row">
        <span className="fbar__label">Folder</span>
        <input className="fsmall fsmall--folder" value={draft.folder} maxLength={400} placeholder="Part of a folder name" spellCheck={false} onChange={(e) => edit({ folder: e.target.value })} />
      </label>
      <label className="more-filters__row">
        <span className="fbar__label">File ending</span>
        <input className="fsmall fsmall--folder" value={draft.extText} maxLength={200} placeholder="pdf, mp4 .mov" spellCheck={false} onChange={(e) => edit({ extText: e.target.value })} />
      </label>
      <div className="more-filters__row">
        <Toggle label="Fewer than 2 other copies" checked={draft.fewCopies} onChange={(fewCopies) => edit({ fewCopies })} />
      </div>
      <div className="more-filters__row">
        <Toggle label="Only files that are gone" checked={draft.gone} onChange={(gone) => edit({ gone })} />
      </div>
      <div className="more-filters__row">
        <Toggle label="Not checked yet (new or changed files)" checked={draft.unfingerprinted} onChange={(unfingerprinted) => edit({ unfingerprinted })} />
      </div>
    </>
  );
}

/** The inside of "More filters": changes wait here until Apply. Reset clears every filter at once. */
function MoreFilters({
  applied,
  onApply,
  onReset,
  close,
  chips,
  facets,
  years,
}: {
  applied: FilterState;
  onApply: (next: FilterState) => void;
  onReset: () => void;
  close: () => void;
  chips: readonly PlaceChip[];
  facets: SearchFacets | null;
  years: readonly number[];
}) {
  // Mounted each time the drop-down opens, so the draft always starts as what is applied.
  const [staged, setStaged] = useState(() => openStaged(applied));
  return (
    <div className="more-filters">
      <Details draft={staged.draft} edit={(patch) => setStaged((s) => editDraft(s, patch))} chips={chips} facets={facets} years={years} />
      <div className="more-filters__foot">
        <Button
          size="sm"
          variant="quiet"
          disabled={sameFilters(applied, NO_FILTERS) && !isDirty(staged)}
          onClick={() => {
            onReset();
            close();
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!isDirty(staged)}
          onClick={() => {
            onApply(applyDraft(staged).applied);
            close();
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

/**
 * The Files filters in one row: quick chips that apply at once, then "More filters" (changes apply on Apply), then the filters
 * that are on as small tags you can remove with one click.
 */
export function FilterBar({
  filters,
  onChange,
  chips,
  facets,
  years,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  chips: readonly PlaceChip[];
  facets: SearchFacets | null;
  years: readonly number[];
}) {
  const labels = new Map(chips.map((chip) => [chip.id, chip.label]));
  const tags = activeFilters(filters, (id) => labels.get(id) ?? 'A place');
  return (
    <>
      <div className="fbar" role="group" aria-label="Filters">
        {QUICK_FILTERS.map((quick) => (
          <button key={quick.id} type="button" className="fchip" aria-pressed={isQuickOn(filters, quick.id)} onClick={() => onChange(toggleQuick(filters, quick.id))}>
            {quick.label}
          </button>
        ))}
        <FilterMenu label="More filters" active={tags.length > 0} summary={tags.length > 0 ? `${tags.length} on` : ''}>
          {(close) => <MoreFilters applied={filters} onApply={onChange} onReset={() => onChange(NO_FILTERS)} close={close} chips={chips} facets={facets} years={years} />}
        </FilterMenu>
      </div>
      {tags.length > 0 ? (
        <ul className="ftags" aria-label="Filters that are on">
          {tags.map((tag) => (
            <li key={tag.key}>
              <button type="button" className="fchip ftag" aria-label={`Remove filter: ${tag.label}`} onClick={() => onChange(removeFilter(filters, tag.key))}>
                {tag.key === 'type' && filters.category ? <CategoryDot category={filters.category} /> : null}
                {tag.label}
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
