// 镜像规则：官方 CDN/API 与 MCIM 镜像的双向映射。
// 依据 MCIM 文档：api.modrinth.com -> mod.mcimirror.top/modrinth；
// cdn.modrinth.com -> mod.mcimirror.top；api.curseforge.com -> mod.mcimirror.top/curseforge；
// edge/mediafilez.forgecdn.net -> mod.mcimirror.top。

export const MIRROR_BASE = 'https://mod.mcimirror.top';

const CDN_HOSTS = new Set(['cdn.modrinth.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net']);

/** 把官方下载/接口 URL 换成镜像 URL；已是镜像或缺省规则的原样返回。 */
export function toMirrorUrl(url, base = MIRROR_BASE) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  const mb = new URL(base);
  if (u.host === mb.host) return url;
  if (CDN_HOSTS.has(u.host)) {
    u.protocol = mb.protocol; u.host = mb.host;
    return u.toString();
  }
  if (u.host === 'api.modrinth.com') {
    u.protocol = mb.protocol; u.host = mb.host; u.pathname = `/modrinth${u.pathname}`;
    return u.toString();
  }
  if (u.host === 'api.curseforge.com') {
    u.protocol = mb.protocol; u.host = mb.host; u.pathname = `/curseforge${u.pathname}`;
    return u.toString();
  }
  return url;
}

/** 镜像 URL 还原成官方 URL（用于客户端回退）。 */
export function toOfficialUrl(url, base = MIRROR_BASE) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  const mb = new URL(base);
  if (u.host !== mb.host) return url;
  const p = u.pathname;
  if (p.startsWith('/modrinth/')) { u.host = 'api.modrinth.com'; u.pathname = p.slice('/modrinth'.length); return u.toString(); }
  if (p.startsWith('/curseforge/')) { u.host = 'api.curseforge.com'; u.pathname = p.slice('/curseforge'.length); return u.toString(); }
  if (p.startsWith('/data/')) { u.host = 'cdn.modrinth.com'; return u.toString(); }
  if (p.startsWith('/files/')) { u.host = 'edge.forgecdn.net'; return u.toString(); }
  return url;
}

export function isMirrorUrl(url, base = MIRROR_BASE) {
  try { return new URL(url).host === new URL(base).host; } catch { return false; }
}

const LINK_HOST_PATTERNS = [
  { kind: 'modrinth', host: /(^|\.)modrinth\.com$/i, label: 'Modrinth' },
  { kind: 'curseforge', host: /(^|\.)curseforge\.com$/i, label: 'CurseForge' },
  { kind: 'github', host: /(^|\.)github\.com$/i, label: 'GitHub' },
  { kind: 'discord', host: /(^|\.)discord\.(gg|com)$/i, label: 'Discord' },
  { kind: 'website', host: /.*/, label: '主页' },
];

/** 从任意文本（描述/displayURL 等）抽取 URL 并分类。 */
export function extractLinks(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>()\[\]，。；、）】]+/gi;
  const seen = new Set();
  const out = [];
  for (const raw of String(text).match(re) || []) {
    let url = raw.replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    let u; try { u = new URL(url); } catch { continue; }
    const pat = LINK_HOST_PATTERNS.find((p) => p.host.test(u.hostname)) || LINK_HOST_PATTERNS[LINK_HOST_PATTERNS.length - 1];
    out.push({ kind: pat.kind, label: pat.label, url });
  }
  return out;
}

/** 项目页 → 可点击的镜像 API 链接（网页本身没有镜像）。 */
export function projectMirrorUrl(link, base = MIRROR_BASE) {
  if (link.kind === 'modrinth') {
    const m = link.url.match(/modrinth\.com\/mod\/([A-Za-z0-9_-]+)/i);
    if (m) return `${base}/modrinth/v2/project/${m[1]}`;
  }
  if (link.kind === 'curseforge') {
    const m = link.url.match(/curseforge\.com\/minecraft\/mc-mods\/([A-Za-z0-9_-]+)/i);
    if (m) return `${base}/curseforge/v1/mods/search?gameId=432&slug=${m[1]}`;
  }
  return null;
}
