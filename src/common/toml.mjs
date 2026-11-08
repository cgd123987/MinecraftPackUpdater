// 面向 neoforge.mods.toml / mods.toml 的 TOML 子集解析器。
// 覆盖真实 mod 元数据里出现的语法：注释、基础串、字面串、多行串、表、表数组、数组、
// 整数/浮点/布尔、内联表、点号键。足以安全读取 description 里的链接与依赖表。

class TomlError extends Error {}

export function parseToml(text) {
  const p = new Parser(text);
  const root = {};
  let table = root;
  p.skipWsAndComments();
  while (!p.eof()) {
    if (p.peek() === '[') {
      const isArray = p.peek(1) === '[';
      p.next(); if (isArray) p.next();
      p.skipInlineWs();
      const path = p.parseKeyPath();
      p.skipInlineWs();
      p.expect(']'); if (isArray) p.expect(']');
      table = isArray ? p.arrayTable(root, path) : p.table(root, path);
      p.skipWsAndComments();
    } else {
      const keyPath = p.parseKeyPath();
      p.skipInlineWs();
      p.expect('=');
      p.skipInlineWs();
      const value = p.parseValue();
      p.assign(table, keyPath, value);
      p.skipWsAndComments();
    }
  }
  return root;
}

class Parser {
  constructor(text) {
    this.s = text.replace(/^\uFEFF/, '');
    this.i = 0;
  }
  eof() { return this.i >= this.s.length; }
  peek(k = 0) { return this.s[this.i + k]; }
  next() { return this.s[this.i++]; }
  expect(ch) {
    if (this.peek() !== ch) throw new TomlError(`位置 ${this.i} 期望 '${ch}'，实际 '${this.peek()}'`);
    this.i++;
  }
  skipInlineWs() { while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t')) this.i++; }
  skipWsAndComments() {
    for (;;) {
      this.skipInlineWs();
      if (this.peek() === '\r') { this.i++; continue; }
      if (this.peek() === '\n') { this.i++; continue; }
      if (this.peek() === '#') { while (!this.eof() && this.peek() !== '\n') this.i++; continue; }
      break;
    }
  }
  parseKeyPath() {
    const parts = [];
    for (;;) {
      this.skipInlineWs();
      const c = this.peek();
      if (c === '"' || c === "'") parts.push(this.parseString());
      else {
        const start = this.i;
        while (!this.eof() && /[A-Za-z0-9_\-]/.test(this.peek())) this.i++;
        if (start === this.i) throw new TomlError(`位置 ${this.i} 期望键名`);
        parts.push(this.s.slice(start, this.i));
      }
      this.skipInlineWs();
      if (this.peek() === '.') { this.i++; continue; }
      break;
    }
    return parts;
  }
  table(root, path) {
    let t = root;
    for (const k of path) {
      if (t[k] === undefined) t[k] = {};
      if (Array.isArray(t[k])) t = t[k][t[k].length - 1];
      else if (typeof t[k] === 'object') t = t[k];
      else throw new TomlError(`键 ${k} 已是标量，不能当表`);
    }
    return t;
  }
  arrayTable(root, path) {
    let t = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (t[k] === undefined) t[k] = {};
      t = Array.isArray(t[k]) ? t[k][t[k].length - 1] : t[k];
    }
    const last = path[path.length - 1];
    if (!Array.isArray(t[last])) t[last] = [];
    const obj = {};
    t[last].push(obj);
    return obj;
  }
  assign(table, path, value) {
    let t = table;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (typeof t[k] !== 'object' || t[k] === null || Array.isArray(t[k])) {
        if (t[k] === undefined) t[k] = {};
        else throw new TomlError(`键 ${k} 冲突`);
      }
      t = t[k];
    }
    t[path[path.length - 1]] = value;
  }
  parseValue() {
    const c = this.peek();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false; }
    return this.parseNumber();
  }
  parseArray() {
    this.expect('[');
    const arr = [];
    this.skipWsAndComments();
    if (this.peek() === ']') { this.i++; return arr; }
    for (;;) {
      this.skipWsAndComments();
      arr.push(this.parseValue());
      this.skipWsAndComments();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === ']') { this.i++; break; }
      throw new TomlError(`位置 ${this.i} 数组语法错误`);
    }
    return arr;
  }
  parseInlineTable() {
    this.expect('{');
    const obj = {};
    this.skipInlineWs();
    if (this.peek() === '}') { this.i++; return obj; }
    for (;;) {
      this.skipInlineWs();
      const kp = this.parseKeyPath();
      this.skipInlineWs();
      this.expect('=');
      this.skipInlineWs();
      this.assign(obj, kp, this.parseValue());
      this.skipInlineWs();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === '}') { this.i++; break; }
      throw new TomlError(`位置 ${this.i} 内联表语法错误`);
    }
    return obj;
  }
  parseNumber() {
    const start = this.i;
    while (!this.eof() && /[0-9A-Za-z_+\-.]/.test(this.peek())) this.i++;
    const raw = this.s.slice(start, this.i);
    if (!raw) throw new TomlError(`位置 ${start} 无法解析的值`);
    const norm = raw.replace(/_/g, '');
    if (/^[+-]?\d+$/.test(norm)) return Number(norm);
    if (/^0x[0-9a-f]+$/i.test(norm)) return parseInt(norm, 16);
    if (/^[+-]?\d*\.\d+([eE][+-]?\d+)?$/.test(norm)) return Number(norm);
    throw new TomlError(`位置 ${start} 无法解析的值: ${raw}`);
  }
  parseString() {
    const q = this.peek();
    if (this.s.startsWith(q.repeat(3), this.i)) return this.parseMultiline(q);
    this.i++;
    let out = '';
    while (!this.eof() && this.peek() !== q) {
      let c = this.next();
      if (q === '"' && c === '\\') c = this.readEscape();
      else if (q === "'" && c === '\\') { /* 字面串不转义 */ out += c; continue; }
      out += c;
    }
    this.expect(q);
    return out;
  }
  parseMultiline(q) {
    this.i += 3;
    if (this.peek() === '\r') this.i++;
    if (this.peek() === '\n') this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) throw new TomlError('多行字符串未闭合');
      if (this.s.startsWith(q.repeat(3), this.i)) { this.i += 3; break; }
      let c = this.next();
      if (q === '"' && c === '\\') {
        // 行尾续行：反斜杠后允许空白换行
        const save = this.i;
        let j = this.i;
        while (j < this.s.length && (this.s[j] === ' ' || this.s[j] === '\t')) j++;
        if (this.s[j] === '\r' || this.s[j] === '\n') {
          this.i = j;
          while (!this.eof() && (this.peek() === '\r' || this.peek() === '\n' || this.peek() === ' ' || this.peek() === '\t')) this.i++;
          continue;
        }
        this.i = save;
        c = this.readEscape();
      }
      out += c;
    }
    return out;
  }
  readEscape() {
    const c = this.next();
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'u': { const h = this.s.slice(this.i, this.i + 4); this.i += 4; return String.fromCharCode(parseInt(h, 16)); }
      case 'U': { const h = this.s.slice(this.i, this.i + 8); this.i += 8; return String.fromCodePoint(parseInt(h, 16)); }
      default: return c;
    }
  }
}
