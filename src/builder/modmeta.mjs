// 从 mod jar 的“版权页/元数据页”抽取信息与链接。
// 兼容 NeoForge(1.21.1 用 META-INF/neoforge.mods.toml)、旧 Forge(mods.toml)、Fabric(fabric.mod.json)、
// 以及 legacy mcmod.info。
import { ZipArchive } from '../common/zip.mjs';
import { parseToml } from '../common/toml.mjs';
import { extractLinks } from '../common/mirror.mjs';

const TOML_CANDIDATES = ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'mods.toml'];
const JSON_CANDIDATES = ['fabric.mod.json', 'quilt.mod.json', 'mcmod.info'];

export function readModJar(jarPath) {
  const zip = ZipArchive.open(jarPath);
  for (const name of TOML_CANDIDATES) {
    const text = zip.readText(name);
    if (text != null) return fromToml(jarPath, name, text);
  }
  for (const name of JSON_CANDIDATES) {
    const text = zip.readText(name);
    if (text != null) return fromJson(jarPath, name, text);
  }
  return { jarPath, format: null, mods: [], loader: null, loaderVersion: null, links: [] };
}

function fromToml(jarPath, entry, text) {
  let root;
  try { root = parseToml(text); } catch (e) {
    return { jarPath, format: 'toml', error: `TOML 解析失败: ${e.message}`, mods: [], loader: null, loaderVersion: null, links: [] };
  }
  const blocks = Array.isArray(root.mods) ? root.mods : [];
  const links = [];
  const mods = blocks.map((m) => {
    const modLinks = collectLinks(m);
    links.push(...modLinks);
    return {
      modId: str(m.modId ?? m.modid),
      name: str(m.displayName ?? m.modId ?? m.modid),
      version: str(m.version),
      authors: str(m.authors),
      license: str(m.license ?? root.license),
      description: str(m.description),
      displayURL: str(m.displayURL),
      issueTrackerURL: str(m.issueTrackerURL),
      links: modLinks,
    };
  });
  return {
    jarPath,
    format: 'toml',
    entry,
    mods,
    loader: str(root.modLoader),
    loaderVersion: str(root.loaderVersion),
    links: mergeLinks(links),
    license: str(root.license),
  };
}

function fromJson(jarPath, entry, text) {
  let root;
  try { root = JSON.parse(text); } catch (e) {
    return { jarPath, format: 'json', error: `JSON 解析失败: ${e.message}`, mods: [], loader: null, loaderVersion: null, links: [] };
  }
  const list = Array.isArray(root) ? root : [root];
  const links = [];
  const mods = list.map((m) => {
    const contacts = m.contact || {};
    const modLinks = extractLinks([m.description, m.homepage, m.source, m.issues, ...Object.values(contacts)].join(' '));
    links.push(...modLinks);
    return {
      modId: str(m.id ?? m.modid),
      name: str(m.name ?? m.id),
      version: str(m.version),
      authors: str(Array.isArray(m.authors) ? m.authors.map((a) => a.name || a).join(', ') : m.authors),
      license: str(m.license),
      description: str(m.description),
      displayURL: str(m.homepage ?? m.contact?.homepage),
      issueTrackerURL: str(m.contact?.issues ?? m.issues),
      environment: str(m.environment),
      links: modLinks,
    };
  });
  return {
    jarPath,
    format: 'json',
    entry,
    mods,
    loader: 'fabric',
    loaderVersion: null,
    links: mergeLinks(links),
    license: str(root.license),
  };
}

function collectLinks(m) {
  const parts = [m.displayURL, m.issueTrackerURL, m.description, m.credits].filter(Boolean);
  const links = [];
  for (const p of parts) links.push(...extractLinks(p));
  return mergeLinks(links);
}

export function mergeLinks(links) {
  const seen = new Map();
  for (const l of links) {
    if (!l?.url) continue;
    const key = l.url.replace(/\/+$/, '').toLowerCase();
    if (!seen.has(key)) seen.set(key, l);
  }
  return [...seen.values()];
}

function str(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function primaryMod(info) {
  return info.mods?.find((m) => m.modId) || null;
}
