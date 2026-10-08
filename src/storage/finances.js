import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const categories = new Set(['Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Entertainment', 'Shopping', 'Income', 'Other']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error('amount must be a whole number of rupiah');
  const rupiah = Number(text);
  if (!Number.isSafeInteger(rupiah) || rupiah <= 0) throw new Error('amount must be greater than zero');
  return rupiah;
}

function validateDate(value) {
  if (typeof value !== 'string' || !datePattern.test(value)) throw new Error('date must use YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('date is invalid');
}

function validateEntry(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('entry must be an object');
  const entry = {};
  if (!partial || input.type !== undefined) {
    if (!['income', 'expense'].includes(input.type)) throw new Error('type must be income or expense');
    entry.type = input.type;
  }
  if (!partial || input.amount !== undefined) entry.amount = parseAmount(input.amount);
  if (!partial || input.date !== undefined) { validateDate(input.date); entry.date = input.date; }
  if (!partial || input.category !== undefined) {
    if (typeof input.category !== 'string' || !categories.has(input.category)) throw new Error('category is invalid');
    entry.category = input.category;
  }
  if (!partial || input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.trim().length > 120) throw new Error('description must be 120 characters or fewer');
    entry.description = input.description.trim();
  }
  return entry;
}

export function createFinanceStore({ file }) {
  let entries = null;
  let writing = Promise.resolve();
  async function load() {
    if (entries) return entries;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(parsed) || parsed.some((entry) => (
        !entry || typeof entry.id !== 'string' || !Number.isSafeInteger(entry.amount) || entry.amount <= 0
        || !['income', 'expense'].includes(entry.type) || typeof entry.date !== 'string'
        || typeof entry.category !== 'string' || typeof entry.description !== 'string'
        || typeof entry.createdAt !== 'string'
      ))) throw new Error('Finance data file has an invalid format');
      entries = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = [];
    }
    return entries;
  }
  async function persist() {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
  async function update(mutator) {
    await load();
    const result = await mutator(entries);
    writing = writing.catch(() => {}).then(persist);
    await writing;
    return result;
  }
  return {
    async list() { return [...(await load())].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); },
    async add(input) {
      const entry = { id: randomUUID(), ...validateEntry(input), createdAt: new Date().toISOString() };
      await update((list) => list.push(entry));
      return entry;
    },
    async updateEntry(id, input) {
      if (typeof id !== 'string') return false;
      const changes = validateEntry(input, { partial: true });
      let updated = null;
      await update((list) => {
        const entry = list.find((item) => item.id === id);
        if (!entry) return;
        Object.assign(entry, changes);
        updated = entry;
      });
      return updated;
    },
    async remove(id) {
      if (typeof id !== 'string') return false;
      let removed = false;
      await update((list) => { const next = list.findIndex((entry) => entry.id === id); if (next >= 0) { list.splice(next, 1); removed = true; } });
      return removed;
    },
  };
}

export { validateEntry };
