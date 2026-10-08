import fs from 'node:fs/promises';
import path from 'node:path';

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('date must be a valid YYYY-MM-DD date');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new TypeError('date must be a valid YYYY-MM-DD date');
  return date;
}

function markdownText(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value.replace(/\r\n?/g, '\n');
}

export function createFridayMemory({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
  const root = path.resolve(directory);
  const daily = path.join(root, 'daily');
  const dailyPath = (date) => path.join(daily, `${validateDate(date)}.md`);
  const ensureDir = async (dir) => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a regular directory: ${dir}`);
    await fs.chmod(dir, 0o700);
  };
  const checkedFile = async (file) => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular file: ${file}`);
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const readRegular = async (file) => {
    const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${file}`);
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  };

  return {
    async appendDailyLog({ date, timestamp, conversationId, userMessage, fridayReply } = {}) {
      const file = dailyPath(date);
      if (typeof timestamp !== 'string' || !timestamp || /[\r\n]/.test(timestamp)) throw new TypeError('timestamp must be a single-line string');
      if (typeof conversationId !== 'string' || !/^[\w.-]{1,128}$/.test(conversationId)) throw new TypeError('invalid conversationId');
      const prompt = markdownText(userMessage, 'userMessage');
      const reply = markdownText(fridayReply, 'fridayReply');
      await ensureDir(root);
      await ensureDir(daily);
      const exists = await checkedFile(file);
      const entry = `${exists ? '' : `# ${date}\n\n`}\n## Needs review\n\n- Timestamp: ${timestamp}\n- Conversation ID: ${conversationId}\n\n### User prompt\n\n${prompt}\n\n### Friday reply\n\n${reply}\n`;
      const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${file}`);
        await handle.writeFile(entry, 'utf8');
      } finally { await handle.close(); }
    },
    async listDailyLogs() {
      try {
        await ensureDir(root);
        await ensureDir(daily);
        const names = await fs.readdir(daily);
        return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && isValidDate(name.slice(0, 10))).sort().map((name) => name.slice(0, -3));
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    async readDailyLog(date) {
      try {
        await ensureDir(root);
        await ensureDir(daily);
        if (!(await checkedFile(dailyPath(date)))) return null;
        return await readRegular(dailyPath(date));
      }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async readMemory() {
      try {
        await ensureDir(root);
        const file = path.join(root, 'MEMORY.md');
        if (!(await checkedFile(file))) return '';
        return await readRegular(file);
      }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    },
    async graph() {
      await ensureDir(root);
      await ensureDir(daily);
      const dates = await this.listDailyLogs();
      const selectedDates = dates.slice(-40);
      const records = [];
      const curated = await this.readMemory();
      if (curated.trim()) records.push({ id: 'MEMORY.md', label: 'Memory', type: 'curated', content: curated });
      for (const date of selectedDates) {
        const file = dailyPath(date);
        if (await checkedFile(file)) records.push({ id: `daily/${date}.md`, label: date, type: 'daily', content: await readRegular(file) });
      }
      const byTarget = new Map();
      for (const record of records) {
        for (const target of [record.id, path.basename(record.id)]) {
          const key = target.replace(/\.md$/i, '').toLocaleLowerCase();
          byTarget.set(key, record.id);
        }
      }
      const edges = new Set();
      for (const record of records) {
        for (const [, rawTarget] of record.content.matchAll(/\[\[([^\]]+)\]\]/g)) {
          const target = rawTarget.split('|', 1)[0].split('#', 1)[0].trim().replace(/\.md$/i, '').toLocaleLowerCase();
          const to = byTarget.get(target) || byTarget.get(path.basename(target));
          if (to && to !== record.id) edges.add(JSON.stringify([record.id, to]));
        }
      }
      return {
        nodes: records.map(({ id, label, type }) => ({ id, label, type })),
        edges: [...edges].map((edge) => { const [source, target] = JSON.parse(edge); return { source, target }; }),
        totalDailyNotes: dates.length,
        truncated: dates.length > selectedDates.length,
      };
    },
    async writeMemory(content) {
      const text = markdownText(content, 'content');
      await ensureDir(root);
      const file = path.join(root, 'MEMORY.md');
      await checkedFile(file);
      const temporary = path.join(root, `.MEMORY.md-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
      try {
        await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    },
  };
}

function isValidDate(date) {
  try { validateDate(date); return true; } catch { return false; }
}
