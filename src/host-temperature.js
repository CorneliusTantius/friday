import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const cacheTtlMs = 30_000;
const maxTemperatureCelsius = 200;

async function directoryEntries(path, readdirImpl) {
  try {
    return await readdirImpl(path);
  } catch (error) {
    return { error };
  }
}

function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM';
}

export function createHostTemperatureMonitor({
  platformName = process.platform,
  sysRoot = '/sys',
  now = Date.now,
  readdirImpl = readdir,
  readFileImpl = readFile,
} = {}) {
  let cached;
  let cachedAt = 0;
  let pending;

  async function sample() {
    const sampledAt = new Date(now()).toISOString();
    if (platformName !== 'linux') return { status: 'unsupported', celsius: null, sampledAt };

    const files = [];
    let permissionDenied = false;
    const hwmonRoot = join(sysRoot, 'class', 'hwmon');
    const hwmonDirs = await directoryEntries(hwmonRoot, readdirImpl);
    if (Array.isArray(hwmonDirs)) {
      for (const name of hwmonDirs) {
        if (!/^hwmon\d+$/.test(name)) continue;
        const directory = join(hwmonRoot, name);
        const entries = await directoryEntries(directory, readdirImpl);
        if (!Array.isArray(entries)) {
          permissionDenied ||= isPermissionError(entries.error);
          continue;
        }
        for (const entry of entries) {
          if (/^temp\d+_input$/.test(entry)) files.push(join(directory, entry));
        }
      }
    } else {
      permissionDenied ||= isPermissionError(hwmonDirs.error);
    }

    const thermalRoot = join(sysRoot, 'class', 'thermal');
    const thermalDirs = await directoryEntries(thermalRoot, readdirImpl);
    if (Array.isArray(thermalDirs)) {
      for (const name of thermalDirs) {
        if (!/^thermal_zone\d+$/.test(name)) continue;
        files.push(join(thermalRoot, name, 'temp'));
      }
    } else {
      permissionDenied ||= isPermissionError(thermalDirs.error);
    }

    const values = [];
    for (const file of files) {
      try {
        const raw = (await readFileImpl(file, 'utf8')).trim();
        if (!/^-?\d+$/.test(raw)) continue;
        const value = Number(raw) / 1000;
        if (Number.isFinite(value) && value >= -40 && value <= maxTemperatureCelsius) values.push(value);
      } catch (error) {
        permissionDenied ||= isPermissionError(error);
      }
    }

    if (values.length) {
      return { status: 'available', celsius: Math.round(Math.max(...values) * 10) / 10, sampledAt };
    }
    return {
      status: permissionDenied ? 'permission-denied' : 'unavailable',
      celsius: null,
      sampledAt,
    };
  }

  return {
    async read() {
      if (cached && now() - cachedAt < cacheTtlMs) return cached;
      if (!pending) {
        pending = sample().then((result) => {
          cached = result;
          cachedAt = now();
          return result;
        }).finally(() => { pending = null; });
      }
      return pending;
    },
  };
}
