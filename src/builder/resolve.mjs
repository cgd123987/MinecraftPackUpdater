// 通过文件哈希在 Modrinth（经 MCIM 镜像）反查发布信息，得到可镜像下载的直链。
// 查不到 = “未发布/私发”，由调用方改为自托管到 Cloudflare Pages。
import { fetchJson } from '../common/http.mjs';
import { toMirrorUrl } from '../common/mirror.mjs';

export class ModrinthResolver {
  constructor({ baseUrl = 'https://mod.mcimirror.top', userAgent, cache } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.cache = cache || null;
    this.cacheDirty = false;
    this.stats = { hit: 0, miss: 0, cached: 0 };
  }

  async resolveBySha1(sha1) {
    if (this.cache?.has(sha1)) {
      const v = this.cache.get(sha1);
      this.stats.cached++;
      return v === false ? null : v;
    }
    const result = await this._lookup(sha1);
    if (this.cache) {
      this.cache.set(sha1, result ?? false);
      this.cacheDirty = true;
    }
    if (result) this.stats.hit++; else this.stats.miss++;
    return result;
  }

  async _lookup(sha1) {
    const url = `${this.baseUrl}/modrinth/v2/version_file/${sha1}?algorithm=sha1`;
    let version;
    try {
      version = await fetchJson(url, { allow404: true, userAgent: this.userAgent, retries: 2 });
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (!version) return null;
    const file = (version.files || []).find((f) => (f.hashes?.sha1 || '').toLowerCase() === sha1.toLowerCase())
      || version.files?.[0];
    if (!file?.url) return null;

    const officialUrl = file.url;
    const mirrorUrl = toMirrorUrl(officialUrl, this.baseUrl);

    let project = null;
    try {
      project = await fetchJson(`${this.baseUrl}/modrinth/v2/project/${version.project_id}`, {
        allow404: true, userAgent: this.userAgent, retries: 1,
      });
    } catch { /* 项目信息获取失败不影响下载 */ }

    return {
      provider: 'modrinth',
      projectId: version.project_id,
      projectSlug: project?.slug ?? null,
      projectTitle: project?.title ?? null,
      versionNumber: version.version_number,
      versionName: version.name ?? null,
      fileName: file.filename,
      size: file.size ?? null,
      url: mirrorUrl,
      officialUrl,
      fallbacks: officialUrl !== mirrorUrl ? [officialUrl] : [],
      projectLinks: project?.source_url ? [{ kind: 'source', label: '源码', url: project.source_url }] : [],
      gameVersions: version.game_versions || [],
      loaders: version.loaders || [],
    };
  }
}

/** 加载/保存解析缓存，避免重复请求镜像。 */
export class ResolveCache {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.map = new Map(Object.entries(initial || {}));
  }
  has(k) { return this.map.has(k); }
  get(k) { const v = this.map.get(k); return v === false ? null : v; }
  set(k, v) { this.map.set(k, v); }
  toJSON() { return Object.fromEntries(this.map); }
}
