import { promises as fs } from "node:fs";
import { join } from "node:path";

import { type ProviderKind } from "../../domain/index.js";
import { defaultCacheDirectory } from "../../application.js";
import { isProviderKind } from "../../domain/records.js";
import {
  DEFAULT_VISIBLE_CARDS,
  DEFAULT_WIDE_CARDS,
  normalizeVisibleCards,
  type DashboardCardKind,
} from "../render/types.js";

export const SETTINGS_MIN_REFRESH_SECONDS = 15;
export const SETTINGS_MAX_REFRESH_SECONDS = 2 * 60 * 60; // 7200
export const SETTINGS_DEFAULT_REFRESH_SECONDS = 300;
export const ALL_PROVIDER_KINDS: readonly ProviderKind[] = ["opencode", "codex", "antigravity"] as const;

/**
 * Settings focus rows, numbered in the order the panel *renders* them:
 * providers (0-2) -> tables (3-4) -> card slots (5-10) -> card count (11)
 * -> refresh interval (12).
 *
 * All six slot rows always render; slots at or past the visible count are
 * dimmed placeholders so the indices below never shift when toggling
 * between four and six cards.
 *
 * `focusedIndex` cycles these with Tab/arrows, so the index order must match
 * the render order or navigation appears to skip rows.
 */
export const SETTINGS_ROWS = {
  providers: 0,
  tables: 3,
  cards: 5,
  cardCount: 11,
  refresh: 12,
  count: 13,
} as const;

export interface DashboardSettings {
  readonly enabledProviders: ReadonlyArray<ProviderKind>;
  readonly refreshIntervalSeconds: number;
  /** Show the Providers breakdown table (default true for legacy files). */
  readonly showProvidersTable?: boolean;
  /** Show the Projects breakdown table (default true for legacy files). */
  readonly showProjectsTable?: boolean;
  /** Four or six visible top cards (default hour/day/week/month for legacy files). */
  readonly visibleCards?: ReadonlyArray<DashboardCardKind>;
  /** Inactive card set of the opposite size (remembered across count toggles). */
  readonly inactiveCards?: ReadonlyArray<DashboardCardKind>;
}

export function clampRefreshIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return SETTINGS_DEFAULT_REFRESH_SECONDS;
  const floored = Math.floor(value);
  return Math.max(SETTINGS_MIN_REFRESH_SECONDS, Math.min(SETTINGS_MAX_REFRESH_SECONDS, floored));
}

export function normalizeRefreshIntervalSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SETTINGS_DEFAULT_REFRESH_SECONDS;
  return clampRefreshIntervalSeconds(value);
}

export function formatRefreshInterval(seconds: number): string {
  const clamped = clampRefreshIntervalSeconds(seconds);
  if (clamped % 3600 === 0) {
    const h = clamped / 3600;
    return `${h}h`;
  }
  if (clamped >= 3600) {
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  if (clamped % 60 === 0) {
    return `${clamped / 60}m`;
  }
  // For non-multiples of 60 (should still clamp but allow display)
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export function settingsToFilterProviders(settings: DashboardSettings): Set<ProviderKind> | undefined {
  const enabled = settings.enabledProviders;
  if (enabled.length === ALL_PROVIDER_KINDS.length) {
    // All enabled => no filter (collect all)
    return undefined;
  }
  if (enabled.length === 0) {
    // Empty would mean nothing to collect; caller should prevent but map to empty set
    return new Set<ProviderKind>();
  }
  return new Set(enabled);
}

export function filterProvidersToEnabled(filterProviders?: Set<ProviderKind>): ReadonlyArray<ProviderKind> {
  if (filterProviders === undefined || filterProviders.size === 0) {
    return [...ALL_PROVIDER_KINDS];
  }
  const result: ProviderKind[] = [];
  for (const kind of ALL_PROVIDER_KINDS) {
    if (filterProviders.has(kind)) result.push(kind);
  }
  // Preserve order of ALL_PROVIDER_KINDS, ignore unknown
  return result;
}

export function normalizeEnabledProviders(value: unknown): ReadonlyArray<ProviderKind> {
  if (!Array.isArray(value)) return [...ALL_PROVIDER_KINDS];
  const filtered = value.filter(isProviderKind);
  // Dedupe preserve order
  const seen = new Set<ProviderKind>();
  const ordered: ProviderKind[] = [];
  for (const kind of ALL_PROVIDER_KINDS) {
    if (filtered.includes(kind) && !seen.has(kind)) {
      seen.add(kind);
      ordered.push(kind);
    }
  }
  // If input contained valid providers but not in order, include them
  for (const kind of filtered) {
    if (!seen.has(kind)) {
      seen.add(kind);
      ordered.push(kind);
    }
  }
  if (ordered.length === 0) return [...ALL_PROVIDER_KINDS];
  return ordered;
}

export function normalizeSettings(value: unknown): DashboardSettings {
  if (typeof value !== "object" || value === null) {
    return {
      enabledProviders: [...ALL_PROVIDER_KINDS],
      refreshIntervalSeconds: SETTINGS_DEFAULT_REFRESH_SECONDS,
      showProvidersTable: true,
      showProjectsTable: true,
      visibleCards: [...DEFAULT_VISIBLE_CARDS],
      inactiveCards: [...DEFAULT_WIDE_CARDS],
    };
  }
  const record = value as Record<string, unknown>;
  const enabled = normalizeEnabledProviders(record.enabledProviders ?? record.providers ?? record.filterProviders);
  const interval = normalizeRefreshIntervalSeconds(record.refreshIntervalSeconds as unknown);
  const active = normalizeVisibleCards(record.visibleCards);
  // The inactive set is always the opposite size. Files predating it fall
  // back to defaults: the wide preset when four show, legacy four when six
  // show (e.g. a 0.1.23 six-list keeps its layout, 4 defaults below it).
  const inactive = record.inactiveCards !== undefined
    ? normalizeVisibleCards(record.inactiveCards, active.length > 4 ? 4 : 6)
    : normalizeVisibleCards(active.length > 4 ? DEFAULT_VISIBLE_CARDS : DEFAULT_WIDE_CARDS, active.length > 4 ? 4 : 6);
  return {
    enabledProviders: enabled,
    refreshIntervalSeconds: interval,
    // Missing (legacy settings.json) means shown.
    showProvidersTable: record.showProvidersTable !== false,
    showProjectsTable: record.showProjectsTable !== false,
    // Missing (legacy settings.json) means the legacy hour/day/week/month layout.
    visibleCards: active,
    inactiveCards: inactive,
  };
}

export function settingsFilePath(cacheDirectory?: string): string {
  const directory = cacheDirectory ?? defaultCacheDirectory();
  return join(directory, "settings.json");
}

export async function loadDashboardSettings(cacheDirectory?: string): Promise<DashboardSettings | undefined> {
  const path = settingsFilePath(cacheDirectory);
  let contents: string;
  try {
    contents = await fs.readFile(path, "utf8");
  } catch (error) {
    // Missing file is normal on first run — silent. Other read errors warn.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      process.stderr.write(`oc2token: warning: failed to read settings at ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    return normalizeSettings(parsed);
  } catch (error) {
    // Preserve corrupt settings for inspection instead of silently discarding.
    try {
      const backup = `${path}.corrupt-${Date.now()}`;
      await fs.writeFile(backup, contents, "utf8");
      process.stderr.write(`oc2token: warning: corrupt settings at ${path} backed up to ${backup}: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      process.stderr.write(`oc2token: warning: corrupt settings at ${path} could not be backed up: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return undefined;
  }
}

export async function saveDashboardSettings(settings: DashboardSettings, cacheDirectory?: string): Promise<void> {
  const path = settingsFilePath(cacheDirectory);
  const directory = cacheDirectory ?? defaultCacheDirectory();
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Do not silently lie about persistence — warn; the dashboard keeps running with in-memory values.
    process.stderr.write(`oc2token: warning: failed to create settings directory at ${directory}: ${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }
  const active = normalizeVisibleCards(settings.visibleCards);
  const payload = JSON.stringify(
    {
      version: 1,
      enabledProviders: [...settings.enabledProviders],
      refreshIntervalSeconds: clampRefreshIntervalSeconds(settings.refreshIntervalSeconds),
      showProvidersTable: settings.showProvidersTable !== false,
      showProjectsTable: settings.showProjectsTable !== false,
      visibleCards: active,
      inactiveCards: normalizeVisibleCards(settings.inactiveCards, active.length > 4 ? 4 : 6),
    },
    null,
    2,
  );
  try {
    await fs.writeFile(path, `${payload}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`oc2token: warning: failed to save settings at ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export const REFRESH_INTERVAL_PRESETS: readonly number[] = [15, 30, 60, 120, 300, 600, 900, 3600, 7200] as const;

export function nearestPresetIndex(value: number): number {
  const clamped = clampRefreshIntervalSeconds(value);
  let bestIndex = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < REFRESH_INTERVAL_PRESETS.length; i += 1) {
    const diff = Math.abs(REFRESH_INTERVAL_PRESETS[i]! - clamped);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function adjustRefreshIntervalByPreset(currentSeconds: number, deltaSteps: number): number {
  const idx = nearestPresetIndex(currentSeconds);
  const nextIdx = Math.max(0, Math.min(REFRESH_INTERVAL_PRESETS.length - 1, idx + deltaSteps));
  return REFRESH_INTERVAL_PRESETS[nextIdx]!;
}

export function adjustRefreshInterval(currentSeconds: number, deltaSteps: number): number {
  // Back-compat: delegate to preset stepping for consistent UI increments
  return adjustRefreshIntervalByPreset(currentSeconds, deltaSteps);
}

export function refreshIntervalPresetIndex(value: number): number {
  return nearestPresetIndex(value);
}

export function refreshIntervalForPresetIndex(index: number): number {
  const clamped = Math.max(0, Math.min(REFRESH_INTERVAL_PRESETS.length - 1, Math.floor(index)));
  return REFRESH_INTERVAL_PRESETS[clamped]!;
}
