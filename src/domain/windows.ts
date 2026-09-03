import { DomainError } from "./errors.js";

export const USAGE_WINDOW_KINDS = ["hour", "day", "week"] as const;
export type UsageWindowKind = (typeof USAGE_WINDOW_KINDS)[number];

export interface UsageWindowBase {
  /** Short stable key used by the CLI and JSON output. */
  readonly kind: UsageWindowKind;
  /** Human-readable semantics; the kind alone must not be interpreted as all-time. */
  readonly semantics: "rolling-hour" | "local-day" | "iso-week";
  /** The IANA time zone used for calendar labels and boundaries. */
  readonly timezone: string;
  /** Inclusive start and exclusive end instants. */
  readonly from: Date;
  readonly to: Date;
  readonly label: string;
}

export interface RollingHourWindow extends UsageWindowBase {
  readonly kind: "hour";
  readonly semantics: "rolling-hour";
}

export interface LocalDayWindow extends UsageWindowBase {
  readonly kind: "day";
  readonly semantics: "local-day";
  /** Local Gregorian date represented as YYYY-MM-DD. */
  readonly localDate: string;
}

export interface ISOWeekWindow extends UsageWindowBase {
  readonly kind: "week";
  readonly semantics: "iso-week";
  readonly isoWeekYear: number;
  readonly isoWeek: number;
  /** ISO week label represented as YYYY-Www. */
  readonly isoWeekLabel: string;
}

export type UsageWindow =
  | RollingHourWindow
  | LocalDayWindow
  | ISOWeekWindow;

export interface UsageWindowSet {
  readonly hour: RollingHourWindow;
  readonly day: LocalDayWindow;
  readonly week: ISOWeekWindow;
}

/** One half-open, timezone-aware interval used to plot a usage trend. */
export interface UsageBucket {
  readonly label: string;
  readonly from: Date;
  readonly to: Date;
}

type CivilDate = Readonly<{ year: number; month: number; day: number }>;
type CivilDateTime = Readonly<CivilDate & { hour: number; minute: number; second: number }>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ISO_WEEK_DAYS = 7;

function assertValidInstant(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("invalid-date", `${name} must be a valid Date`);
  }
}

function assertTimeZone(timezone: string): void {
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    throw new DomainError("invalid-timezone", "timezone must not be empty");
  }

  try {
    // Constructing the formatter is the portable way to validate an IANA zone
    // without depending on a third-party time-zone database.
    new Intl.DateTimeFormat("en-US-u-ca-gregory", { timeZone: timezone }).format();
  } catch (error) {
    throw new DomainError("invalid-timezone", `Invalid IANA timezone: ${timezone}`, {
      cause: error,
    });
  }
}

function utcDateTime(value: CivilDateTime): Date {
  const result = new Date(0);
  result.setUTCFullYear(value.year, value.month - 1, value.day);
  result.setUTCHours(value.hour, value.minute, value.second, 0);
  return result;
}

// Cached formatters: partsFor/instantAtLocal can run hundreds of times per
// refresh (offset sampling calls partsFor ~25x per instantAtLocal, plus one
// per candidate). Constructing Intl.DateTimeFormat each time dominates the
// profile, so instances are cached per time zone. The cache is bounded in
// practice by the distinct time zones in a single process (normally one).
const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const labelFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-hc-h23", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatterCache.set(timezone, formatter);
  }
  return formatter;
}

function trendLabelFormatter(timezone: string, kind: UsageWindowKind): Intl.DateTimeFormat {
  const key = `${timezone}\0${kind}`;
  let formatter = labelFormatterCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(
      "en-CA",
      kind === "week"
        ? { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }
        : { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    );
    labelFormatterCache.set(key, formatter);
  }
  return formatter;
}

function partsFor(instant: Date, timezone: string): CivilDateTime {
  assertValidInstant(instant, "instant");
  const formatter = partsFormatter(timezone);
  const parts = new Map(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  const hour = Number(parts.get("hour"));
  const minute = Number(parts.get("minute"));
  const second = Number(parts.get("second"));

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    throw new DomainError("invalid-timezone", "Timezone formatting did not return a complete date");
  }

  return { year, month, day, hour: hour === 24 ? 0 : hour, minute, second };
}

function localDateAt(instant: Date, timezone: string): CivilDate {
  const { year, month, day } = partsFor(instant, timezone);
  return { year, month, day };
}

function sameDateTime(left: CivilDateTime, right: CivilDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function offsetAt(instant: Date, timezone: string): number {
  // Intl exposes local calendar parts rather than an offset. Formatting a
  // whole-second instant as UTC and subtracting the instant recovers that
  // offset, including changes caused by DST.
  const instantMilliseconds = Math.floor(instant.getTime() / 1000) * 1000;
  const local = partsFor(new Date(instantMilliseconds), timezone);
  return utcDateTime(local).getTime() - instantMilliseconds;
}

/**
 * Resolve a local civil time to an instant without assuming every day is 24h.
 * Ambiguous local times use the earliest matching instant, which makes a
 * repeated midnight the start of the first occurrence. Midnight normally
 * exists even on DST transition days; the iterative fallback also gives a
 * deterministic answer for historical zones that skip a civil time.
 */
function instantAtLocal(when: CivilDateTime, timezone: string): Date {
  const targetMilliseconds = utcDateTime(when).getTime();
  const possibleOffsets = new Set<number>();

  // Sampling around the naive UTC value finds both sides of a DST transition,
  // including the two offsets that can map to an ambiguous local time.
  for (let hour = -72; hour <= 72; hour += 6) {
    possibleOffsets.add(offsetAt(new Date(targetMilliseconds + hour * HOUR_MS), timezone));
  }

  const matches = [...possibleOffsets]
    .map((offset) => new Date(targetMilliseconds - offset))
    .filter((candidate) => sameDateTime(partsFor(candidate, timezone), when));

  if (matches.length > 0) {
    return new Date(Math.min(...matches.map((candidate) => candidate.getTime())));
  }

  // A local time can be skipped by a timezone rule. Iterate the offset until
  // stable instead of applying a fixed offset or assuming a 24-hour day.
  let candidateMilliseconds = targetMilliseconds;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nextMilliseconds = targetMilliseconds - offsetAt(new Date(candidateMilliseconds), timezone);
    if (nextMilliseconds === candidateMilliseconds) {
      break;
    }
    candidateMilliseconds = nextMilliseconds;
  }

  return new Date(candidateMilliseconds);
}

function civilDayNumber(date: CivilDate): number {
  return Math.floor(utcDateTime({ ...date, hour: 0, minute: 0, second: 0 }).getTime() / DAY_MS);
}

function civilDateFromDayNumber(dayNumber: number): CivilDate {
  const date = new Date(dayNumber * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  return civilDateFromDayNumber(civilDayNumber(date) + days);
}

function dateString(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function isoDayOfWeek(date: CivilDate): number {
  const day = new Date(civilDayNumber(date) * DAY_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

function isoWeekInfo(date: CivilDate): Readonly<{ year: number; week: number; monday: CivilDate }> {
  const monday = addCivilDays(date, 1 - isoDayOfWeek(date));
  const thursday = addCivilDays(monday, 3);
  const isoYear = thursday.year;
  // ISO week 1 is the week containing January 4, not necessarily the week
  // containing January 1 (the latter can still belong to the prior ISO year).
  const fourthJanuary = { year: isoYear, month: 1, day: 4 };
  const firstMonday = addCivilDays(fourthJanuary, 1 - isoDayOfWeek(fourthJanuary));
  const week = Math.floor((civilDayNumber(monday) - civilDayNumber(firstMonday)) / ISO_WEEK_DAYS) + 1;
  return { year: isoYear, week, monday };
}

function assertWindowRange(from: Date, to: Date, kind: UsageWindowKind): void {
  assertValidInstant(from, `${kind}.from`);
  assertValidInstant(to, `${kind}.to`);
  if (from.getTime() >= to.getTime()) {
    throw new DomainError("invalid-window", `${kind} window must have from < to`);
  }
}

/** Build one explicitly bounded usage window from one captured wall-clock instant. */
export function createUsageWindow(
  kind: "hour",
  now: Date,
  timezone: string,
): RollingHourWindow;
export function createUsageWindow(
  kind: "day",
  now: Date,
  timezone: string,
): LocalDayWindow;
export function createUsageWindow(
  kind: "week",
  now: Date,
  timezone: string,
): ISOWeekWindow;
export function createUsageWindow(
  kind: UsageWindowKind,
  now: Date,
  timezone: string,
): UsageWindow {
  assertValidInstant(now, "now");
  assertTimeZone(timezone);

  if (!USAGE_WINDOW_KINDS.includes(kind)) {
    throw new DomainError("invalid-window", `Unknown usage window kind: ${String(kind)}`);
  }

  if (kind === "hour") {
    const from = new Date(now.getTime() - HOUR_MS);
    const to = new Date(now.getTime());
    assertWindowRange(from, to, kind);
    return {
      kind,
      semantics: "rolling-hour",
      timezone,
      from,
      to,
      label: "last 60 minutes",
    };
  }

  const currentDate = localDateAt(now, timezone);
  const dayStart = instantAtLocal({ ...currentDate, hour: 0, minute: 0, second: 0 }, timezone);

  if (kind === "day") {
    const nextDate = addCivilDays(currentDate, 1);
    const nextStart = instantAtLocal({ ...nextDate, hour: 0, minute: 0, second: 0 }, timezone);
    assertWindowRange(dayStart, nextStart, kind);
    const localDate = dateString(currentDate);
    return {
      kind,
      semantics: "local-day",
      timezone,
      from: dayStart,
      to: nextStart,
      localDate,
      label: localDate,
    };
  }

  const week = isoWeekInfo(currentDate);
  const nextMonday = addCivilDays(week.monday, ISO_WEEK_DAYS);
  const weekStart = instantAtLocal({ ...week.monday, hour: 0, minute: 0, second: 0 }, timezone);
  const weekEnd = instantAtLocal({ ...nextMonday, hour: 0, minute: 0, second: 0 }, timezone);
  assertWindowRange(weekStart, weekEnd, kind);
  const isoWeekLabel = `${String(week.year).padStart(4, "0")}-W${String(week.week).padStart(2, "0")}`;
  return {
    kind,
    semantics: "iso-week",
    timezone,
    from: weekStart,
    to: weekEnd,
    isoWeekYear: week.year,
    isoWeek: week.week,
    isoWeekLabel,
    label: isoWeekLabel,
  };
}

/** Build all v1 windows from the same captured instant, avoiding boundary drift. */
export function createUsageWindows(
  now: Date,
  timezone: string,
): UsageWindowSet {
  return {
    hour: createUsageWindow("hour", now, timezone),
    day: createUsageWindow("day", now, timezone),
    week: createUsageWindow("week", now, timezone),
  };
}

function trendBucketLabel(instant: Date, timezone: string, kind: UsageWindowKind): string {
  try {
    return trendLabelFormatter(timezone, kind).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/**
 * Build the stable trend intervals for a requested window. Calendar-day
 * buckets advance in elapsed time from the local-day bounds, which preserves
 * both missing and repeated hours on DST transition days. Week buckets use
 * local midnights, so a DST day changes the bucket duration without changing
 * the seven-day shape of the ISO week.
 */
export function createUsageTrendBuckets(window: UsageWindow): readonly UsageBucket[] {
  assertTimeZone(window.timezone);
  assertWindowRange(window.from, window.to, window.kind);

  const buckets: UsageBucket[] = [];
  const append = (from: Date, to: Date): void => {
    const clippedFrom = Math.max(window.from.getTime(), from.getTime());
    const clippedTo = Math.min(window.to.getTime(), to.getTime());
    if (clippedFrom >= clippedTo) return;
    const bucketFrom = new Date(clippedFrom);
    buckets.push({
      label: trendBucketLabel(bucketFrom, window.timezone, window.kind),
      from: bucketFrom,
      to: new Date(clippedTo),
    });
  };

  if (window.kind === "hour") {
    const bucketDuration = 5 * 60 * 1_000;
    for (let cursor = window.from.getTime(); cursor < window.to.getTime(); cursor += bucketDuration) {
      append(new Date(cursor), new Date(Math.min(window.to.getTime(), cursor + bucketDuration)));
    }
    return buckets;
  }

  if (window.kind === "day") {
    const bucketDuration = HOUR_MS;
    for (let cursor = window.from.getTime(); cursor < window.to.getTime(); cursor += bucketDuration) {
      append(new Date(cursor), new Date(Math.min(window.to.getTime(), cursor + bucketDuration)));
    }
    return buckets;
  }

  const localStart = localDateAt(window.from, window.timezone);
  for (let day = 0; day < ISO_WEEK_DAYS; day += 1) {
    const fromLocal = addCivilDays(localStart, day);
    const toLocal = addCivilDays(localStart, day + 1);
    append(
      instantAtLocal({ ...fromLocal, hour: 0, minute: 0, second: 0 }, window.timezone),
      instantAtLocal({ ...toLocal, hour: 0, minute: 0, second: 0 }, window.timezone),
    );
  }
  return buckets;
}

export function containsInstant(window: UsageWindow, instant: Date): boolean {
  assertValidInstant(instant, "instant");
  return instant.getTime() >= window.from.getTime() && instant.getTime() < window.to.getTime();
}
