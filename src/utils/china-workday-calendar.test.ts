import assert from "node:assert/strict";
import test from "node:test";

import {
  isChinaAdjustedWorkday,
  isChinaStatutoryHoliday,
  isSmartNonWorkday,
  isSmartWorkday,
} from "./china-workday-calendar.js";

test("China workday calendar recognizes statutory holidays and adjusted workdays", () => {
  const normalWeekday = new Date("2026-04-15T10:00:00");
  const normalWeekend = new Date("2026-04-18T10:00:00");
  const statutoryHoliday = new Date("2026-01-01T10:00:00");
  const adjustedWorkday = new Date("2026-01-04T10:00:00");

  assert.equal(isChinaStatutoryHoliday(statutoryHoliday), true);
  assert.equal(isChinaAdjustedWorkday(adjustedWorkday), true);
  assert.equal(isSmartWorkday(normalWeekday), true);
  assert.equal(isSmartWorkday(normalWeekend), false);
  assert.equal(isSmartWorkday(statutoryHoliday), false);
  assert.equal(isSmartWorkday(adjustedWorkday), true);
  assert.equal(isSmartNonWorkday(statutoryHoliday), true);
  assert.equal(isSmartNonWorkday(adjustedWorkday), false);
});

test("China workday calendar falls back to weekday rules outside maintained years", () => {
  assert.equal(isSmartWorkday(new Date("2027-01-04T10:00:00")), true);
  assert.equal(isSmartWorkday(new Date("2027-01-09T10:00:00")), false);
});
