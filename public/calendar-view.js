export function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseLocalDayKey(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function formatEventTime(event, timeZone, locale) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  let endLabel = time.format(end);
  const startDay = dayKeyInTimeZone(start, timeZone);
  const endDay = dayKeyInTimeZone(end, timeZone);
  if (startDay !== endDay) {
    const includeYear = startDay.slice(0, 4) !== endDay.slice(0, 4);
    const date = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}), timeZone });
    endLabel += ` (${date.format(end)})`;
  }
  return `${time.format(start)} – ${endLabel} · ${timeZone}`;
}

export function buildMonthDays(year, month, selectedDay, today = new Date()) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const selectedKey = localDayKey(selectedDay);
  const todayKey = localDayKey(today);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const key = localDayKey(date);
    return { date, key, inMonth: date.getMonth() === month, selected: key === selectedKey, today: key === todayKey };
  });
}

export function shiftMonth(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

export function countEventsByDay(events, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  const counts = new Map();
  for (const event of events) {
    const key = dayKeyInTimeZone(new Date(event.start), timeZone);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
