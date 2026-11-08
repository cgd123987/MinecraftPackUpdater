// wrangler CLI 封装：优先用全局安装的 wrangler，没有就回退 npx。
// 认证支持两条路：1) CLOUDFLARE_API_TOKEN 环境变量；2) `wrangler login` 的 OAuth 登录态。
import { spawnSync } from 'node:child_process';

let cachedCommand = null;

export function wranglerCommand(cfg) {
  if (cfg?.pages?.wranglerCommand) return cfg.pages.wranglerCommand;
  if (cachedCommand) return cachedCommand;
  const probe = spawnSync('wrangler --version', { shell: true, encoding: 'utf8', timeout: 60000 });
  cachedCommand = probe.status === 0 ? 'wrangler' : 'npx --yes wrangler@4';
  return cachedCommand;
}

export function buildEnv(cfg) {
  const env = { ...process.env };
  if (cfg?.pages?.apiToken) env.CLOUDFLARE_API_TOKEN = cfg.pages.apiToken;
  if (cfg?.pages?.accountId) env.CLOUDFLARE_ACCOUNT_ID = cfg.pages.accountId;
  env.WRANGLER_SEND_METRICS = 'false';
  return env;
}

/** 运行 wrangler 子命令；inherit=true 时直接接管终端（用于 login）。 */
export function runWrangler(cfg, args, opts = {}) {
  const { cwd, env = buildEnv(cfg), inherit = false } = opts;
  const cmd = `${wranglerCommand(cfg)} ${args.map(quote).join(' ')}`;
  if (inherit) {
    const r = spawnSync(cmd, { cwd, env, shell: true, stdio: 'inherit' });
    return { status: r.status ?? 1, output: '' };
  }
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status ?? 1, output: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 是否已登录（OAuth 或 token）。返回 {ok, email, accountId, raw}。 */
export function checkAuth(cfg) {
  const env = buildEnv(cfg);
  const hasToken = !!env.CLOUDFLARE_API_TOKEN;
  const r = runWrangler(cfg, ['whoami'], { env });
  const raw = r.output || '';
  const email = raw.match(/associated with the email\s+([\w.+-]+@[\w.-]+\.\w+)/i)?.[1]
    || raw.match(/([\w.+-]+@[\w.-]+\.\w+)/)?.[1]
    || null;
  const accountId = raw.match(/\b([0-9a-f]{32})\b/i)?.[1] || null;
  const loggedIn = /You are logged in/i.test(raw) || (hasToken && r.status === 0);
  return { ok: loggedIn && r.status === 0, email, accountId, hasToken, raw, status: r.status };
}

/** 交互式 OAuth 登录（会打开浏览器）。 */
export function login(cfg, opts = {}) {
  const r = runWrangler(cfg, ['login'], { cwd: opts.cwd, inherit: true });
  if (r.status !== 0) throw new Error('wrangler login 失败或被取消');
  const auth = checkAuth(cfg);
  if (!auth.ok) throw new Error('登录后仍未检测到有效凭据，请重试');
  return auth;
}

export function quote(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s;
}
