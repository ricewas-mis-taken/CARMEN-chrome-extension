// Minimal fake DOM + chrome.* so chrome/popup/popup.js can run under plain node. No network, no browser.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export function makeEl(id) {
  const listeners = {};
  const el = {
    id, value: "", textContent: "", innerHTML: "", disabled: false, placeholder: "", dataset: {}, style: { setProperty() {} }, children: [],
    classes: new Set(),
    classList: { add: (...c) => c.forEach((x) => el.classes.add(x)), remove: (...c) => c.forEach((x) => el.classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !el.classes.has(c) : !!f; on ? el.classes.add(c) : el.classes.delete(c); return on; }, contains: (c) => el.classes.has(c) },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    click: () => el.disabled ? Promise.resolve() : Promise.all((listeners.click || []).map((f) => f({ target: el }))),
    appendChild: (c) => { el.children.push(c); return c; }, insertAdjacentElement: () => {}, remove() {}, focus() {}, querySelector: () => makeEl("q"), querySelectorAll: () => [],
    previousElementSibling: null, parentElement: { id: "app" },
  };
  return el;
}
export async function loadPopup({ root = ".", dir = "chrome", sendMessage, fetchImpl }) {
  const els = {};
  const getEl = (id) => (els[id] ||= makeEl(id));
  globalThis.document = { getElementById: getEl, querySelector: () => makeEl("q"), querySelectorAll: () => [], createElement: () => makeEl("new"), addEventListener() {} };
  const store = {};
  const storage = { get: async (k) => (typeof k === "string" && k in store ? { [k]: structuredClone(store[k]) } : {}), set: async (o) => { Object.assign(store, structuredClone(o)); }, remove: async (k) => { delete store[k]; } };
  const api = { storage: { local: storage }, runtime: { sendMessage, getURL: (p) => p }, tabs: { create() {} } };
  globalThis.chrome = api; globalThis.browser = api;
  globalThis.fetch = fetchImpl || (async () => { throw new Error("no network (stub)"); });
  const realSI = globalThis.setInterval; globalThis.setInterval = (f, ms) => { const id = realSI(f, 1e9); id.unref?.(); return id; };
  await import(pathToFileURL(path.resolve(root, dir, "popup/popup.js")).href + "?" + Math.random());
  return { els, getEl, store };
}
