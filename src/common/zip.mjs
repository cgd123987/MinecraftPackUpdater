// 最小 ZIP 读取器：只读中央目录 + inflateRaw，够读 jar 里的 META-INF/*.toml。
// 不处理 ZIP64 / 加密 / 多卷（mod jar 不会用到）。
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipArchive {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf;
    this.entries = new Map();
    this._readCentralDirectory();
  }

  static open(filePath) {
    return new ZipArchive(readFileSync(filePath));
  }

  _readCentralDirectory() {
    const buf = this.buf;
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 0x10000 - 22);
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/JAR：找不到 EOCD');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error('ZIP 中央目录损坏');
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const uncompSize = buf.readUInt32LE(off + 24);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
      this.entries.set(name, { name, method, compSize, uncompSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  list() { return [...this.entries.keys()]; }

  /** @returns {Buffer|null} */
  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOff) !== LOC_SIG) throw new Error(`ZIP 本地头损坏: ${name}`);
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const dataOff = e.localOff + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataOff, dataOff + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  readText(name) {
    const b = this.read(name);
    return b ? b.toString('utf8') : null;
  }
}
