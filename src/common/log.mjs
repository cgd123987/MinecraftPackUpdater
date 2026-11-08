// 终端输出：分等级、颜色、单行进度。
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  gray: c(90), red: c(31), green: c(32), yellow: c(33), blue: c(36), magenta: c(35), bold: c(1),
};

let lastProgressLen = 0;

export function log(msg) { console.log(msg); }
export function info(msg) { console.log(`${color.blue('[信息]')} ${msg}`); }
export function ok(msg) { console.log(`${color.green('[完成]')} ${msg}`); }
export function warn(msg) { console.log(`${color.yellow('[警告]')} ${msg}`); }
export function error(msg) { console.error(`${color.red('[错误]')} ${msg}`); }
export function step(msg) { console.log(`\n${color.bold(msg)}`); }

export function progress(label, current, total, extra = '') {
  if (!useColor) return;
  const pct = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
  const width = 24;
  const filled = Math.round((pct / 100) * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const line = `\r${color.gray('│')} ${bar} ${String(pct).padStart(3)}% ${label} ${extra}`;
  const pad = Math.max(0, lastProgressLen - line.length);
  process.stdout.write(line + ' '.repeat(pad));
  lastProgressLen = line.length;
}

export function progressDone() {
  if (lastProgressLen > 0) {
    process.stdout.write('\n');
    lastProgressLen = 0;
  }
}
