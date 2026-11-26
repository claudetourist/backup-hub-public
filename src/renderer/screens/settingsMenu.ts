/** The groups of the Settings left menu, in order. Pure data, so it can be tested. */
export const SETTINGS_GROUPS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'drives', label: 'Drives and accounts' },
  { id: 'performance', label: 'Performance' },
  { id: 'people', label: 'People' },
  { id: 'security', label: 'Security' },
  { id: 'tools', label: 'Tools' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

export const DEFAULT_SETTINGS_GROUP: SettingsGroupId = 'appearance';

/** A group from text such as a dev link ("#settings,security"); the default when nothing matches. */
export function groupFromText(text: string): SettingsGroupId {
  const lower = text.toLowerCase();
  return SETTINGS_GROUPS.find((g) => lower.includes(g.id))?.id ?? DEFAULT_SETTINGS_GROUP;
}

/** The group after or before `current` for the arrow keys; stops at the ends. */
export function neighbourGroup(current: SettingsGroupId, step: 1 | -1): SettingsGroupId {
  const index = SETTINGS_GROUPS.findIndex((g) => g.id === current);
  return SETTINGS_GROUPS[Math.min(SETTINGS_GROUPS.length - 1, Math.max(0, index + step))]!.id;
}
