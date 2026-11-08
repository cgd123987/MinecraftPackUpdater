// 发布到 Cloudflare Pages：调用官方 wrangler CLI（负责资源哈希、增量上传与部署）。
// 认证：优先 CLOUDFLARE_API_TOKEN；没有 token 时用 `wrangler login` 的 OAuth 登录态，
// 未登录且终端可交互时会自动拉起浏览器登录。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJson, sleep } from '../common/http.mjs';
import { buildEnv, checkAuth, login, runWrangler } from './wrangler.mjs';
import { info, ok, warn, step } from '../common/log.mjs';

export async function publish(cfg, opts = {}) {
  const siteDir = join(cfg.paths.outDir, 'site');
  if (!existsSync(join(siteDir, 'latest.json'))) {
    throw new Error('没有找到待发布的站点，请先执行 build');
  }
  const latest = JSON.parse(await readFile(join(siteDir, 'latest.json'), 'utf8'));
  const baseUrl = (cfg.pages.baseUrl || '').replace(/\/+$/, '');
  if (!cfg.pages.project) throw new Error('未配置 pages.project');
  if (!baseUrl) throw new Error('未配置 pages.baseUrl（或 pages.project，用于推导 *.pages.dev）');

  step('检查 Cloudflare 登录状态');
  const auth = ensureAuth(cfg, opts);
  if (auth.hasToken) info('使用 CLOUDFLARE_API_TOKEN 认证');
  else if (auth.email) ok(`已登录：${auth.email}`);
  if (auth.accountId) info(`账号 ID：${auth.accountId}`);

  step('检查远端是否已是最新');
  if (!opts.force) {
    const remote = await fetchJson(`${baseUrl}/latest.json?t=${Date.now()}`, { allow404: true, retries: 1 })
      .catch(() => null);
    if (remote?.contentHash === latest.contentHash) {
      ok(`远端 contentHash 一致（${latest.version}），跳过部署以节省 Pages 构建额度`);
      return { skipped: true, version: latest.version };
    }
    info(remote ? `远端版本 ${remote.version} → 本地 ${latest.version}` : '远端暂无 latest.json，首次发布');
  }

  const env = buildEnv(cfg);
  step('调用 wrangler 上传站点');
  info(`项目: ${cfg.pages.project}  分支: ${cfg.pages.branch}  目录: ${siteDir}`);
  let res = runWrangler(cfg, ['pages', 'deploy', '.', '--project-name', cfg.pages.project, '--branch', cfg.pages.branch, '--commit-dirty=true'], { cwd: siteDir, env });

  if (res.status !== 0 && /Project not found|project.*does not exist|8000007/i.test(res.output)) {
    warn('Pages 项目不存在，尝试创建…');
    const created = runWrangler(cfg, ['pages', 'project', 'create', cfg.pages.project, '--production-branch', cfg.pages.branch], { cwd: siteDir, env });
    if (created.status !== 0) throw new Error(`创建 Pages 项目失败:\n${created.output.slice(-2000)}`);
    ok(`已创建 Pages 项目：${cfg.pages.project}`);
    res = runWrangler(cfg, ['pages', 'deploy', '.', '--project-name', cfg.pages.project, '--branch', cfg.pages.branch, '--commit-dirty=true'], { cwd: siteDir, env });
  }
  if (res.status !== 0) {
    throw new Error(`wrangler 部署失败（退出码 ${res.status}）:\n${res.output.slice(-3000)}`);
  }
  if (process.env.AUTOPACK_VERBOSE) process.stdout.write(res.output);

  step('校验线上内容');
  let online = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    online = await fetchJson(`${baseUrl}/latest.json?t=${Date.now()}`, { allow404: true, retries: 0 }).catch(() => null);
    if (online?.contentHash === latest.contentHash) break;
  }
  if (online?.contentHash === latest.contentHash) {
    ok(`已上线：${baseUrl}  （版本 ${latest.version}）`);
    ok(`版权页：${baseUrl}/catalog`);
  } else {
    warn(`部署已提交，但线上 latest.json 尚未更新（CDN 传播延迟）。稍后访问 ${baseUrl}/latest.json 确认。`);
  }
  return { skipped: false, version: latest.version, baseUrl };
}

/** 确保有可用认证：token 或 OAuth；未登录时按需拉起 `wrangler login`。 */
export function ensureAuth(cfg, opts = {}) {
  let auth = checkAuth(cfg);
  if (auth.ok) return auth;

  const canLogin = process.stdin.isTTY && opts.login !== false;
  if (!canLogin) {
    throw new Error(
      '未登录 Cloudflare。\n'
      + '  · 方式一（推荐）：在能打开浏览器的终端运行 `AutoPackBuilder.exe login`，或 `npx wrangler login`\n'
      + '  · 方式二：设置环境变量 CLOUDFLARE_API_TOKEN（权限 Account → Cloudflare Pages → Edit）',
    );
  }
  warn('未检测到 Cloudflare 登录态，即将打开浏览器登录（完成后会自动继续）…');
  auth = login(cfg, { cwd: cfg.paths.outDir });
  ok(`登录成功：${auth.email || '(已获取凭据)'}`);
  return auth;
}
