import assert from "node:assert/strict";
import test from "node:test";
import {
  containsInstant,
  createUsageWindow,
  createUsageWindows,
} from "../../src/domain/index.js";

const instant = (value: string): Date => new Date(value);
const hours = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 3_600_000;

test("rolling hour is an exact half-open 60-minute instant interval", () => {
  const now = instant("2026-09-02T10:15:30.000Z");
  const window = createUsageWindow("hour", now, "Europe/Istanbul");

  assert.equal(window.semantics, "rolling-hour");
  assert.equal(window.timezone, "Europe/Istanbul");
  assert.equal(window.from.toISOString(), "2026-09-02T09:15:30.000Z");
  assert.equal(window.to.toISOString(), now.toISOString());
  assert.equal(containsInstant(window, window.from), true);
  assert.equal(containsInstant(window, window.to), false);
});

test("local day uses 23 and 25 elapsed hours across New York DST", () => {
  const spring = createUsageWindow(
    "day",
    instant("2024-03-10T16:00:00.000Z"),
    "America/New_York",
  );
  const fall = createUsageWindow(
    "day",
    instant("2024-11-03T17:00:00.000Z"),
    "America/New_York",
  );

  assert.equal(spring.localDate, "2024-03-10");
  assert.equal(spring.from.toISOString(), "2024-03-10T05:00:00.000Z");
  assert.equal(spring.to.toISOString(), "2024-03-11T04:00:00.000Z");
  assert.equal(hours(spring.from, spring.to), 23);

  assert.equal(fall.localDate, "2024-11-03");
  assert.equal(fall.from.toISOString(), "2024-11-03T04:00:00.000Z");
  assert.equal(fall.to.toISOString(), "2024-11-04T05:00:00.000Z");
  assert.equal(hours(fall.from, fall.to), 25);
});

test("ISO week rolls on local Monday and preserves DST-safe bounds", () => {
  const beforeMonday = createUsageWindow(
    "week",
    instant("2021-01-03T23:00:00.000Z"),
    "UTC",
  );
  const monday = createUsageWindow(
    "week",
    instant("2021-01-04T00:00:00.000Z"),
    "UTC",
  );
  const springWeek = createUsageWindow(
    "week",
    instant("2024-03-10T16:00:00.000Z"),
    "America/New_York",
  );
  const fallWeek = createUsageWindow(
    "week",
    instant("2024-11-03T17:00:00.000Z"),
    "America/New_York",
  );

  assert.equal(beforeMonday.isoWeekLabel, "2020-W53");
  assert.equal(monday.isoWeekLabel, "2021-W01");
  assert.equal(beforeMonday.from.toISOString(), "2020-12-28T00:00:00.000Z");
  assert.equal(beforeMonday.to.toISOString(), "2021-01-04T00:00:00.000Z");
  assert.equal(containsInstant(beforeMonday, monday.from), false);

  assert.equal(springWeek.isoWeekLabel, "2024-W10");
  assert.equal(hours(springWeek.from, springWeek.to), 167);
  assert.equal(fallWeek.isoWeekLabel, "2024-W44");
  assert.equal(hours(fallWeek.from, fallWeek.to), 169);
});

test("window construction rejects an invalid timezone and invalid instant", () => {
  assert.throws(
    () => createUsageWindow("day", instant("2026-09-02T10:00:00.000Z"), "Not/AZone"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid-timezone",
  );
  assert.throws(
    () => createUsageWindows(new Date("invalid"), "UTC"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid-date",
  );
});
