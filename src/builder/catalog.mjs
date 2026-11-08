// 版权页（catalog）：把每个 mod jar 元数据里的 Modrinth/CurseForge 链接整理出来，
// 并给出“镜像下载”直链。生成的 catalog.html 与 catalog.json 一起发布到 Pages。
import { projectMirrorUrl } from '../common/mirror.mjs';

const KIND_LABEL = { modrinth: 'Modrinth', curseforge: 'CurseForge', github: 'GitHub', discord: 'Discord', website: '主页', source: '源码' };

export function buildCatalog(manifest) {
  const mods = [];
  for (const f of manifest.files) {
    const infos = f.mods?.length ? f.mods : [{ modId: null, name: f.path.split('/').pop(), version: null }];
    for (const info of infos) {
      const links = (info.links || []).map((l) => ({
        kind: l.kind,
        label: KIND_LABEL[l.kind] || l.kind,
        url: l.url,
        mirrorUrl: projectMirrorUrl(l),
      }));
      mods.push({
        modId: info.modId,
        name: info.name,
        version: info.version,
        authors: info.authors,
        license: info.license,
        description: info.description,
        links,
        file: f.path,
        role: f.role,
        size: f.size,
        sha1: f.sha1,
        sha256: f.sha256,
        source: {
          kind: f.source.kind,
          url: f.source.url,
          projectId: f.source.projectId || null,
          provider: f.source.provider || 'self',
          versionNumber: f.source.versionNumber || null,
        },
      });
    }
  }
  return {
    schema: 1,
    packId: manifest.packId,
    packName: manifest.packName,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    game: manifest.game,
    counts: {
      mods: mods.length,
      files: manifest.files.length,
      mirrored: manifest.files.filter((f) => f.source.kind === 'mirror').length,
      selfHosted: manifest.files.filter((f) => f.source.kind === 'pages').length,
    },
    mods,
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function renderCatalogHtml(catalog) {
  const rows = catalog.mods.map((m) => {
    const links = m.links.length
      ? m.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label)}</a>`).join('')
      : '<span class="dim">—</span>';
    const mirrorLinks = m.links.filter((l) => l.mirrorUrl)
      .map((l) => `<a class="mirror" href="${esc(l.mirrorUrl)}" target="_blank" rel="noreferrer">${esc(l.label)} 镜像</a>`)
      .join('');
    const dl = m.source.kind === 'pages'
      ? `<a class="dl" href="${esc(m.source.url)}">本站下载</a>`
      : `<a class="dl" href="${esc(m.source.url)}">镜像下载</a>`;
    return `<tr data-search="${esc([m.name, m.modId, m.authors, m.version].filter(Boolean).join(' ').toLowerCase())}">
      <td><div class="name">${esc(m.name)}</div><div class="sub">${esc(m.modId || '')}${m.version ? ` · ${esc(m.version)}` : ''}</div></td>
      <td class="desc">${esc(m.description || '')}</td>
      <td>${esc(m.authors || '')}${m.license ? `<div class="sub">${esc(m.license)}</div>` : ''}</td>
      <td class="file"><div class="mono">${esc(m.file)}</div><div class="sub">${esc(fmtSize(m.size))} · ${m.source.provider === 'modrinth' ? 'Modrinth' : '自托管'}</div></td>
      <td class="links">${links}<div class="sub">${mirrorLinks}</div></td>
      <td class="actions">${dl}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(catalog.packName)} · 模组版权页</title>
<style>
:root{--bg:#0f1117;--card:#171a22;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--accent:#5aa9ff;--green:#4ade80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:28px 20px 16px;max-width:1280px;margin:0 auto}
h1{margin:0 0 4px;font-size:22px}
.meta{color:var(--dim);font-size:13px}
.stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;color:var(--dim);font-size:13px}
.stats b{color:var(--fg)}
.toolbar{max-width:1280px;margin:0 auto;padding:0 20px 12px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:14px;outline:none}
input:focus{border-color:var(--accent)}
main{max-width:1280px;margin:0 auto;padding:0 20px 60px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--dim);font-weight:600;position:sticky;top:0;background:#1b1f29}
tr:last-child td{border-bottom:0}
tr:hover td{background:#1b1f29}
.name{font-weight:600}
.sub{color:var(--dim);font-size:12px;margin-top:2px}
.desc{color:#c3c9d6;max-width:340px}
.mono,.file{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
.links a{display:inline-block;margin:0 8px 4px 0;color:var(--accent);text-decoration:none;font-size:12px}
.links a.mirror{color:var(--green)}
.links a:hover{text-decoration:underline}
.actions a.dl{display:inline-block;padding:6px 10px;border-radius:6px;background:#1e3a5f;color:#9ecbff;text-decoration:none;font-size:12px;white-space:nowrap}
.actions a.dl:hover{background:#24486f}
.dim{color:var(--dim)}
footer{max-width:1280px;margin:0 auto;padding:0 20px 40px;color:var(--dim);font-size:12px}
@media(max-width:820px){.desc,.file{display:none}}
</style></head><body>
<header>
  <h1>${esc(catalog.packName)} · 模组版权页</h1>
  <div class="meta">整合包版本 <b>${esc(catalog.version)}</b> · 发布于 ${esc(catalog.publishedAt)} · Minecraft ${esc(catalog.game.minecraft)} / ${esc(catalog.game.loader)} ${esc(catalog.game.loaderVersion || '')}</div>
  <div class="stats">
    <span>模组 <b>${catalog.counts.mods}</b></span>
    <span>镜像直链 <b>${catalog.counts.mirrored}</b></span>
    <span>本站托管 <b>${catalog.counts.selfHosted}</b></span>
  </div>
</header>
<div class="toolbar"><input id="q" placeholder="搜索模组名 / modid / 作者…" autofocus></div>
<main><table>
<thead><tr><th>模组</th><th>简介</th><th>作者 / 许可</th><th>文件</th><th>源站链接</th><th>下载</th></tr></thead>
<tbody>${rows}</tbody>
</table></main>
<footer>链接来自各 mod jar 内 <span class="mono">META-INF/neoforge.mods.toml</span> 的版权信息；下载直链已替换为 MCIM 镜像（mod.mcimirror.top）。镜像未收录或超过 20MB 的文件回退官方源，本站自托管文件不经过第三方。</footer>
<script>
const q=document.getElementById('q');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();for(const tr of document.querySelectorAll('tbody tr')){tr.style.display=(!v||tr.dataset.search.includes(v))?'':'none'}});
</script>
</body></html>`;
}

export function renderIndexHtml(catalog, latest) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(catalog.packName)}</title>
<style>body{margin:0;background:#0f1117;color:#e6e9ef;font:15px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:60px 20px}
h1{font-size:26px;margin:0 0 8px}.dim{color:#8b93a7}
a{color:#5aa9ff}.card{background:#171a22;border:1px solid #262b36;border-radius:12px;padding:20px;margin-top:20px}
code{background:#0b0d12;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body><main>
<h1>${esc(catalog.packName)}</h1>
<div class="dim">Minecraft ${esc(catalog.game.minecraft)} · ${esc(catalog.game.loader)} ${esc(catalog.game.loaderVersion || '')} · 版本 ${esc(catalog.version)}</div>
<div class="card">
  <p>本页是整合包的更新源，玩家请使用 <b>AutoPackClient.exe</b> 更新。</p>
  <p><a href="catalog">→ 模组版权页 / 下载列表</a></p>
  <p class="dim">客户端读取的接口：<code>latest.json</code> · <code>packs/${esc(catalog.version)}/manifest.json</code></p>
</div>
</main></body></html>`;
}
