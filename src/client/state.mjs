// 客户端本地状态：只记录“本工具装过什么”，用于安全地替换/清理。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prettyJson } from '../common/json.mjs';
import { ensureDir, writeFileAtomic } from '../common/fsutil.mjs';

export const STATE_SCHEMA = 1;

export function emptyState(packId = null) {
  return {
    schema: STATE_SCHEMA,
    packId,
    installedVersion: null,
    lastSyncAt: null,
    lastResult: null,
    files: {},
    optOut: [],
  };
}

export class ClientState {
  constructor(gameDir) {
    this.gameDir = gameDir;
    this.path = join(gameDir, '.autopack', 'state.json');
    this.data = emptyState();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.data = { ...emptyState(), ...raw, files: raw.files || {}, optOut: raw.optOut || [] };
    } catch {
      this.data = emptyState();
    }
    return this.data;
  }

  async save() {
    await ensureDir(join(this.gameDir, '.autopack'));
    await writeFileAtomic(this.path, prettyJson(this.data));
  }

  getFile(path) { return this.data.files[path] || null; }
  setFile(path, info) { this.data.files[path] = info; }
  removeFile(path) { delete this.data.files[path]; }
}
