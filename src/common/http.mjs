// HTTP 工具：统一 UA、超时、重试、下载落盘（带进度与大小校验）。
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_UA = 'AutoPackUpdater/0.1 (+https://github.com/; mcim mirror client)';

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

/** GET/POST JSON（带重试）。非 2xx 抛 HttpError；404 由调用方用 allow404 处理。 */
export async function fetchJson(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 2,
    allow404 = false, allowStatus = [], userAgent = DEFAULT_UA,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': userAgent, Accept: 'application/json', ...headers },
        body,
        signal: withTimeout(timeoutMs),
      });
      if (allow404 && res.status === 404) return null;
      if (!res.ok && !allowStatus.includes(res.status)) {
        throw new HttpError(`HTTP ${res.status} ${url}`, res.status, url);
      }
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new HttpError(`响应不是 JSON: ${url}`, res.status, url); }
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** 流式下载到文件，返回字节数。先写 .part，成功后改名。 */
export async function downloadFile(url, destPath, opts = {}) {
  const {
    timeoutMs = 60000, retries = 2, expectedSize = null, onProgress = null,
    userAgent = DEFAULT_UA, headers = {},
  } = opts;
  await mkdir(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, ...headers },
        signal: withTimeout(timeoutMs),
      });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} ${url}`, res.status, url);
      let received = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, expectedSize);
      });
      await pipeline(body, createWriteStream(partPath));
      if (expectedSize != null) {
        const st = await stat(partPath);
        if (st.size !== expectedSize) {
          throw new HttpError(`尺寸不符：期望 ${expectedSize}，实际 ${st.size} (${url})`, 0, url);
        }
      }
      await rm(destPath, { force: true });
      await rename(partPath, destPath);
      return received;
    } catch (e) {
      lastErr = e;
      await rm(partPath, { force: true });
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
