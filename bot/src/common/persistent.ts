import path from 'path';
import { promises as fs } from 'node:fs';
import type { AppConfig } from '../types/config';
import type { PersistentStore } from '../types/persistent';

type Deps = {
  cfg: AppConfig;
  log?: any;
};

let persistentFilePath = '';
let logRef: any = null;

function resolvePersistentPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

function initFromDeps({ cfg, log }: Deps): void {
  if (!cfg?.app?.persistent_path || typeof cfg.app.persistent_path !== 'string') {
    throw new Error('cfg.app.persistent_path missing or invalid');
  }
  persistentFilePath = resolvePersistentPath(cfg.app.persistent_path);
  logRef = log ?? null;
}

function ensureInit(): string {
  if (!persistentFilePath) {
    throw new Error('persistent module not initialized');
  }
  return persistentFilePath;
}

export async function loadPersistent(deps: Deps): Promise<PersistentStore | null> {
  initFromDeps(deps);
  const fp = ensureInit();
  try {
    const raw = await fs.readFile(fp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logRef?.warn?.({ fp }, 'persistent file root is not an object, ignoring');
      return null;
    }
    return parsed as PersistentStore;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    logRef?.error?.({ err, fp }, 'failed to load persistent file');
    return null;
  }
}

export async function savePersistent(data: PersistentStore): Promise<void> {
  const fp = ensureInit();
  const dir = path.dirname(fp);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${fp}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, fp);
}
