// Minimal fake DOM + chrome for running a plain-script popup.js under node (no real browser).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './Nora-harness.mjs';

export function runPopup(file, { status, onMessage } = {}) {
  const handlers = {}; const elements = {};
  const mk = (id) => {
    const cls = new Set();
    const el = {
      id, value: '', textContent: '', disabled: false, style: {}, dataset: {}, placeholder: '', children: [],
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); } },
      addEventListener: (t, f) => { (handlers[id] ||= {})[t] = f; },
      appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; },
      focus() {}, click() { handlers[id]?.click?.(); }, classes: cls,
    };
    return el;
  };
  const document = {
    getElementById: (id) => (elements[id] ||= mk(id)),
    querySelectorAll: () => [], querySelector: () => mk('q'), createElement: () => mk('c'),
  };
  const intervals = new Map(); let nextId = 1; const sent = [];
  const sandbox = {
    document, console, Promise, Date, Math, Number, String, Array, Set, Map, JSON, Object,
    setTimeout: () => 0, clearTimeout() {},
    setInterval: (f, ms) => { const id = nextId++; intervals.set(id, { f, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { create() {} },
      runtime: { getURL: (x) => x, sendMessage: (m, cb) => { sent.push(m.type); const r = onMessage ? onMessage(m) : { ok: true }; Promise.resolve().then(() => cb && cb(r)); } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  return { elements, handlers, intervals, sent, tick: () => new Promise((r) => setImmediate(r)) };
}
