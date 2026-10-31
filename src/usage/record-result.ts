import { containsInstant, sumUsageRecords } from "../domain/index.js";
import type {
  CollectionError,
  CollectionResult,
  CollectionSource,
  Coverage,
  UsageBreakdown,
  UsageBreakdownsByWindow,
  UsageRecord,
  UsageTotalsByWindow,
  UsageWindow,
} from "../domain/index.js";

export interface RecordResultInput {
  readonly capturedAt: Date;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly source: CollectionSource;
  readonly records: ReadonlyArray<UsageRecord>;
  readonly sessionsDiscovered: number;
  readonly sessionsScanned: number;
  readonly sessionsSkipped: number;
  readonly pagesRead: number;
  readonly provisionalMessages?: number;
  readonly errors: ReadonlyArray<CollectionError>;
}

function sortedErrors(errors: ReadonlyArray<CollectionError>): ReadonlyArray<CollectionError> {
  return [...errors].sort((left, right) =>
    (String(left.sessionID ?? "") + "\0" + left.code + "\0" + left.message).localeCompare(
      String(right.sessionID ?? "") + "\0" + right.code + "\0" + right.message,
    ),
  );
}

function groupBreakdowns(
  records: ReadonlyArray<UsageRecord>,
  window: UsageWindow,
  select: (record: UsageRecord) => string | undefined,
  withProvider = false,
): ReadonlyArray<UsageBreakdown> {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const name = select(record);
    if (name === undefined || name.length === 0) continue;
    const bucket = groups.get(name);
    if (bucket === undefined) groups.set(name, [record]);
    else bucket.push(record);
  }
  const breakdowns: UsageBreakdown[] = [];
  for (const [name, group] of groups.entries()) {
    const totals = sumUsageRecords(group, window);
    breakdowns.push(withProvider ? { name, provider: name, totals } : { name, totals });
  }
  return breakdowns.sort(
    (left, right) => right.totals.recorded_total - left.totals.recorded_total || left.name.localeCompare(right.name),
  );
}

/**
 * Shared finalization for local-file scanners. Derives per-window totals and
 * provider/model/project breakdowns from the normalized records so every
 * file-backed provider reports the same shape as the Codex scanner.
 */
export function buildRecordResult(input: RecordResultInput): CollectionResult {
  const errors = sortedErrors(input.errors);
  const coverage: Coverage = {
    complete: errors.length === 0 && input.sessionsSkipped === 0,
    sessionsDiscovered: input.sessionsDiscovered,
    sessionsScanned: input.sessionsScanned,
    sessionsSkipped: input.sessionsSkipped,
    pagesRead: input.pagesRead,
    jobsRetried: 0,
    provisionalMessages: input.provisionalMessages ?? 0,
    errors,
  };

  const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
    input.windows.map((window) => [window.kind, sumUsageRecords(input.records, window)]),
  );

  const providersByWindow: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const modelsByWindow: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const projectsByWindow: Record<string, ReadonlyArray<UsageBreakdown>> = {};

  for (const window of input.windows) {
    const inWindow = input.records.filter((record) => containsInstant(window, record.createdAt));
    if (inWindow.length === 0) continue;

    const providers = groupBreakdowns(inWindow, window, (record) => record.provider, true);
    if (providers.length > 0) providersByWindow[window.kind] = providers;

    const models = groupBreakdowns(inWindow, window, (record) => record.model);
    if (models.length > 0) modelsByWindow[window.kind] = models;

    const projects = groupBreakdowns(inWindow, window, (record) => record.project);
    if (projects.length > 0) projectsByWindow[window.kind] = projects;
  }

  const pickGlobal = (
    byWindow: Record<string, ReadonlyArray<UsageBreakdown>>,
  ): ReadonlyArray<UsageBreakdown> | undefined => {
    const preferred = byWindow.week ?? byWindow.day ?? byWindow.hour;
    if (preferred !== undefined) return preferred;
    const all = Object.values(byWindow).flat();
    return all.length > 0 ? all : undefined;
  };

  const providers = pickGlobal(providersByWindow);
  const models = pickGlobal(modelsByWindow);
  const projects = pickGlobal(projectsByWindow);
  const providersByWindowTyped: UsageBreakdownsByWindow = providersByWindow;
  const modelsByWindowTyped: UsageBreakdownsByWindow = modelsByWindow;
  const projectsByWindowTyped: UsageBreakdownsByWindow = projectsByWindow;

  return {
    capturedAt: new Date(input.capturedAt.getTime()),
    windows: input.windows.map((window) => ({
      ...window,
      from: new Date(window.from.getTime()),
      to: new Date(window.to.getTime()),
    })),
    source: input.source,
    records: input.records,
    totalsByWindow,
    ...(providers === undefined ? {} : { providers }),
    ...(models === undefined ? {} : { models }),
    ...(projects === undefined ? {} : { projects }),
    ...(Object.keys(providersByWindow).length === 0 ? {} : { providersByWindow: providersByWindowTyped }),
    ...(Object.keys(modelsByWindow).length === 0 ? {} : { modelsByWindow: modelsByWindowTyped }),
    ...(Object.keys(projectsByWindow).length === 0 ? {} : { projectsByWindow: projectsByWindowTyped }),
    coverage,
  };
}
