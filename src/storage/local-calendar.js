import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_EVENTS = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validDate(value, label) {
  const parts = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/) : null;
  if (!parts || !ISO_DATETIME.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO date-time with a timezone`);
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const validCalendarDate = Number(year) >= 1000 && date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
  const validTime = Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
  const validOffset = !offsetHour || (Number(offsetHour) < 14 || (Number(offsetHour) === 14 && Number(offsetMinute) === 0)) && Number(offsetMinute) < 60;
  if (!validCalendarDate || !validTime || !validOffset) fail(`${label} must be a valid ISO date-time with a timezone`);
  return new Date(value).toISOString();
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Event data must be an object');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 160 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)) fail('Event title is required and must be at most 160 characters');
  const description = input.description === undefined ? '' : input.description;
  if (typeof description !== 'string' || description.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) fail('Event description must be at most 2000 characters');
  const start = validDate(input.start, 'Start');
  const end = validDate(input.end, 'End');
  if (Date.parse(end) <= Date.parse(start)) fail('Event end must be after its start');
  if (Date.parse(end) - Date.parse(start) > 366 * 24 * 60 * 60 * 1000) fail('Event duration cannot exceed one year');
  const timeZone = input.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 100) fail('A valid IANA time zone is required');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
  catch { fail('A valid IANA time zone is required'); }
  return { title, description, start, end, timeZone };
}

export function createLocalCalendarStore({ file, now = () => new Date().toISOString() } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('Calendar data file path is required');
  let events;
  let queue = Promise.resolve();
  const filename = file;

  async function load() {
    if (events) return;
    let handle;
    try {
      const info = await lstat(filename);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES || (info.mode & 0o077)) {
        throw new Error('Local Calendar data file is not a safe private file');
      }
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const data = JSON.parse(await handle.readFile('utf8'));
      if (!data || data.version !== 1 || !Array.isArray(data.events) || data.events.length > MAX_EVENTS) throw new Error('Local Calendar data file has an unsupported format');
      const seen = new Set();
      events = data.events.map((event) => {
        if (!event || !UUID.test(event.id) || seen.has(event.id)) throw new Error('Local Calendar data contains an invalid event');
        seen.add(event.id);
        return { id: event.id, ...validateInput(event), createdAt: validDate(event.createdAt, 'Created'), updatedAt: validDate(event.updatedAt, 'Updated') };
      });
    } catch (error) {
      if (error.code === 'ENOENT') events = [];
      else throw error;
    } finally { await handle?.close(); }
  }

  async function persist() {
    const directory = dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('Local Calendar data directory is not a real directory');
    await chmod(directory, 0o700);
    const content = `${JSON.stringify({ version: 1, events })}\n`;
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail('Calendar data is full; delete events before adding more', 413);
    const temporary = join(directory, `.calendar-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, filename);
      await chmod(filename, 0o600);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  function mutate(operation) {
    const result = queue.then(async () => {
      await load();
      const previous = events;
      events = [...events];
      try {
        const value = operation();
        await persist();
        if (value === null) events = previous;
        return value;
      } catch (error) {
        events = previous;
        throw error;
      }
    });
    queue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await queue;
      await load();
      return [...events].sort((a, b) => a.start.localeCompare(b.start));
    },
    async create(input) {
      const values = validateInput(input);
      return mutate(() => {
        if (events.length >= MAX_EVENTS) fail(`Calendar is limited to ${MAX_EVENTS} events`, 413);
        const timestamp = validDate(now(), 'Current time');
        const event = { id: randomUUID(), ...values, createdAt: timestamp, updatedAt: timestamp };
        events.push(event);
        return event;
      });
    },
    async update(id, input) {
      if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid Calendar event ID');
      const values = validateInput(input);
      return mutate(() => {
        const index = events.findIndex((event) => event.id === id);
        if (index < 0) return null;
        const event = { ...events[index], ...values, updatedAt: validDate(now(), 'Current time') };
        events[index] = event;
        return event;
      });
    },
    async delete(id) {
      if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid Calendar event ID');
      return mutate(() => {
        const index = events.findIndex((event) => event.id === id);
        if (index < 0) return null;
        return events.splice(index, 1)[0];
      });
    },
  };
}
