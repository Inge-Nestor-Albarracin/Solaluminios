// Headless Edge driven through the DevTools protocol, controlled over a local
// HTTP port, to take clean, sharp screenshots for the user manual.
//   node driver.mjs                       (keeps running)
//   POST /eval        body: JS (async function body; `return` a value)
//   POST /viewport    body: {"width":1280,"height":800,"scale":1.5,"mobile":false}
//   POST /shot?name=x[&selector=css][&pad=12][&full=1]   saves out/<name>.jpg
//   POST /goto        body: url
//   POST /wheel       body: {"x":400,"y":400,"deltaY":1000,"times":1,"modifiers":0}  (2 = Ctrl)
//   POST /quit
// Screenshots go to ./out (git-ignored). EDGE_PATH overrides the Edge location.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(HERE, 'edge-profile')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--lang=es-CO', '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* not up yet */ }
}
if (!target) throw new Error('Edge did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

// Page helpers available as window.__m in every document.
const HELPERS = `
window.__m = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  all: (sel, root = document) => [...root.querySelectorAll(sel)],
  byText(sel, text, root = document) {
    const want = text.toLowerCase();
    return [...root.querySelectorAll(sel)].find((el) => el.textContent.trim().toLowerCase() === want)
      ?? [...root.querySelectorAll(sel)].find((el) => el.textContent.trim().toLowerCase().includes(want));
  },
  field(label, root = document) {
    const want = label.toLowerCase();
    const holder = [...root.querySelectorAll('label, .field')].find((el) => (el.querySelector('span, .field-label')?.textContent ?? el.textContent).trim().toLowerCase().startsWith(want));
    return holder?.querySelector('input, select, textarea') ?? null;
  },
  set(el, value) {
    if (!el) throw new Error('set: element not found');
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  pick(select, text) {
    if (!select) throw new Error('pick: select not found');
    const opt = [...select.options].find((o) => o.value === text || o.textContent.trim() === text) ?? [...select.options].find((o) => o.textContent.includes(text));
    if (!opt) throw new Error('pick: option not found ' + text);
    this.set(select, opt.value);
  },
  click(el) { if (!el) throw new Error('click: element not found'); el.scrollIntoView({ block: 'center' }); el.click(); },
  nav(label) { this.click(this.byText('nav button, aside button, .sidebar button', label)); },
  top(el, offset = 16) { const y = el.getBoundingClientRect().top + window.scrollY - offset; window.scrollTo(0, Math.max(0, y)); },
  async until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch {} await this.sleep(120); } throw new Error('until: timeout'); },
};`;
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
await send('Runtime.evaluate', { expression: HELPERS });

const evaluate = async (body) => {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${body}\n })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
};

let metrics = { width: 1280, height: 800, scale: 1.5, mobile: false };
const viewport = async (m) => {
  metrics = { ...metrics, ...m };
  await send('Emulation.setDeviceMetricsOverride', { width: metrics.width, height: metrics.height, deviceScaleFactor: metrics.scale, mobile: metrics.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: metrics.mobile, maxTouchPoints: metrics.mobile ? 5 : 1 });
};
await viewport({});
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

const shot = async (name, selector, pad = 12, full = false) => {
  let params = { format: 'jpeg', quality: 90 };
  if (selector) {
    const box = await evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };`);
    if (!box) throw new Error(`shot: ${selector} not found`);
    params = { ...params, captureBeyondViewport: true, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 1 } };
  } else if (full) {
    const size = await evaluate('return { w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight };');
    params = { ...params, captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } };
  }
  const { data } = await send('Page.captureScreenshot', params);
  const file = join(OUT, `${name}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    let out;
    if (url.pathname === '/eval') out = await evaluate(body);
    else if (url.pathname === '/viewport') { await viewport(JSON.parse(body || '{}')); out = metrics; }
    else if (url.pathname === '/goto') { await send('Page.navigate', { url: body.trim() }); await new Promise((r) => setTimeout(r, 1500)); out = 'ok'; }
    else if (url.pathname === '/shot') out = await shot(url.searchParams.get('name'), url.searchParams.get('selector'), Number(url.searchParams.get('pad') ?? 12), url.searchParams.get('full') === '1');
    else if (url.pathname === '/wheel') {
      const { x = 400, y = 400, deltaY = 1000, times = 1, modifiers = 0 } = JSON.parse(body || '{}');
      for (let i = 0; i < times; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });
        await new Promise((r) => setTimeout(r, 150));
      }
      await new Promise((r) => setTimeout(r, 800));
      out = 'ok';
    }
    else if (url.pathname === '/quit') { res.end('bye'); ws.close(); edge.kill(); server.close(); return; }
    else throw new Error('unknown path');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out ?? null));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error?.message ?? error));
  }
});
server.listen(9444, '127.0.0.1', () => console.log('driver ready on 9444'));
