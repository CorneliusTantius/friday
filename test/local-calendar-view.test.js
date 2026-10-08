import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthDays, countEventsByDay, dayKeyInTimeZone, formatEventTime, localDayKey, parseLocalDayKey, shiftMonth } from '../public/calendar-view.js';

const localDate = (year, month, day) => new Date(year, month, day, 12);

test('month grid renders six Monday-first weeks with selected, today, and outside-month dates', () => {
  const days = buildMonthDays(2024, 1, localDate(2024, 1, 29), localDate(2024, 1, 29));
  assert.equal(days.length, 42);
  assert.equal(days[0].key, '2024-01-29');
  assert.equal(days[0].inMonth, false);
  assert.ok(days.some((day) => day.key === '2024-02-29' && day.inMonth && day.selected && day.today));
  assert.equal(days.at(-1).key, '2024-03-10');
});

test('month navigation handles year boundaries and leap-month lengths', () => {
  assert.equal(localDayKey(shiftMonth(localDate(2025, 0, 31), -1)), '2024-12-01');
  assert.equal(localDayKey(shiftMonth(localDate(2024, 11, 15), 1)), '2025-01-01');
  const marchGrid = buildMonthDays(2024, 2, localDate(2024, 2, 1));
  assert.ok(marchGrid.some((day) => day.key === '2024-02-29' && !day.inMonth));
});

test('event placement follows the calendar display zone across UTC date boundaries', () => {
  const event = { start: '2026-06-01T00:30:00.000Z' };
  assert.equal(dayKeyInTimeZone(new Date(event.start), 'Asia/Tokyo'), '2026-06-01');
  assert.equal(dayKeyInTimeZone(new Date(event.start), 'America/Los_Angeles'), '2026-05-31');
  assert.equal(countEventsByDay([event], 'America/Los_Angeles').get('2026-05-31'), 1);
  assert.equal(countEventsByDay([event], 'Asia/Tokyo').get('2026-06-01'), 1);
});

test('cross-midnight events show their end date in each timezone when it differs', () => {
  const event = { start: '2026-06-01T06:30:00.000Z', end: '2026-06-01T08:30:00.000Z' };
  assert.match(formatEventTime(event, 'America/Los_Angeles', 'en-US'), /11:30 PM – 1:30 AM \(Mon, Jun 1\)/);
  assert.match(formatEventTime(event, 'Asia/Tokyo', 'en-US'), /3:30 PM – 5:30 PM/);
  assert.doesNotMatch(formatEventTime(event, 'Asia/Tokyo', 'en-US'), /\(Mon, Jun 1\)/);
  assert.match(formatEventTime({ start: '2026-12-31T23:30:00Z', end: '2027-01-01T00:30:00Z' }, 'UTC', 'en-US'), /Fri, Jan 1, 2027/);
});

test('date-only calendar selections remain local dates through leap day and DST', () => {
  for (const key of ['2024-02-29', '2026-03-08', '2026-11-01']) {
    assert.equal(localDayKey(parseLocalDayKey(key)), key);
  }
  assert.equal(parseLocalDayKey('2026-02-30'), null);
});

test('event indicators count multiple events on the same local calendar day', () => {
  const counts = countEventsByDay([
    { start: '2026-06-01T10:00:00.000Z' },
    { start: '2026-06-01T15:00:00.000Z' },
    { start: '2026-06-02T01:00:00.000Z' },
  ], 'UTC');
  assert.equal(counts.get('2026-06-01'), 2);
  assert.equal(counts.get('2026-06-02'), 1);
});
