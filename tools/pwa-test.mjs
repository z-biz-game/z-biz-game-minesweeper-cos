#!/usr/bin/env node
/* pwa-test.mjs —— "可安装"不是一行 <link rel="manifest">，而是一串能在 node 里跑死的断言。
 *
 * 为什么要有这个文件：sellability 的 `可安装(PWA)` 只看 manifest 里有没有 start_url/display/
 * 大号图标 + 代码里出现过 serviceWorker 字样。这五条全绿，仍然可以是：图标指向不存在的文件、
 * sizes 写错、sw.js 有语法错（CI 的 node --check 只扫 js/ 与 tools/*.mjs，root 下的 sw.js
 * 此前没人 check 过）、缓存名没有版本（旧缓存永远不清）、cache-first 把玩家钉死在旧代码上、
 * file:// 下注册抛红（Electron 就是 file://）。所以这里分两段：
 *   A 段 静态真值：manifest 能 parse、每个 src 在盘上、PNG IHDR 的宽高与 sizes 一致、
 *            index.html 引用的每个本地路径存在、sw 预缓存清单逐条存在。
 *   B 段 运行时行为：给 sw.js 造一个最小 ServiceWorkerGlobalScope，真的 install/activate/fetch，
 *            断言网络优先、断网退缓存、离线导航回落 index.html、未命中不抛、跨域与非 GET 不接管、
 *            旧版本缓存被清。行为不靠 grep。
 *
 *   node tools/pwa-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

// ---------------------------------------------------------------- A. 静态真值
const mfPath = 'manifest.webmanifest';
ok(`${mfPath} 存在`, fs.existsSync(path.join(ROOT, mfPath)));
const mf = JSON.parse(read(mfPath).toString('utf8'));
for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
  ok(`manifest.${k} 有值`, mf[k] !== undefined && mf[k] !== '', String(mf[k]));
}
ok('manifest.display 是可安装取值', ['standalone', 'fullscreen', 'minimal-ui'].includes(mf.display), mf.display);
ok('manifest 有 maskable 图标', (mf.icons || []).some((i) => /maskable/.test(i.purpose || '')));
ok('manifest 有 ≥512 的 any 图标', (mf.icons || []).some((i) => (i.sizes || '').split('x')[0] >= 512
  && !/maskable/.test(i.purpose || '')));

const pngSize = (abs) => {
  const b = fs.readFileSync(abs);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;   // 不是 PNG（SVG 冒充会在这里红）
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
};
for (const icon of mf.icons || []) {
  const rel = icon.src.replace(/^\.\//, '');
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { ok(`图标在盘上: ${rel}`, false, 'missing'); continue; }
  const dim = pngSize(abs);
  ok(`图标是合法 PNG: ${rel}`, !!dim, '非 PNG 字节头');
  const [cw, ch] = String(icon.sizes).split('x').map(Number);
  ok(`图标尺寸与 sizes 一致: ${rel}`, dim && dim.w === cw && dim.h === ch,
    dim ? `${dim.w}x${dim.h} vs ${cw}x${ch}` : '-');
  ok(`图标非 0 字节: ${rel}`, dim && dim.bytes > 100, String(dim && dim.bytes));
}

const html = read('index.html').toString('utf8');
for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
  const rel = m[1].replace(/^\.\//, '');
  ok(`index.html 引用在盘上: ${rel}`, fs.existsSync(path.join(ROOT, rel)));
}
ok('index.html 挂 manifest', /<link[^>]+rel=["']manifest["']/.test(html));
ok('index.html 有唯一 apple-touch-icon',
  (html.match(/rel=["']apple-touch-icon["']/g) || []).length === 1);
ok('index.html 有 apple-mobile-web-app-capable',
  /name=["']apple-mobile-web-app-capable["']/.test(html));

const swSrc = read('sw.js').toString('utf8');
const precache = (swSrc.match(/^\s*['"]((?:[\w.-]+\/)*[\w.-]+)['"],?$/gm) || [])
  .map((s) => s.trim().replace(/^['"]|['"],?$/g, ''))
  .filter((s) => /[./][a-z]+$/.test(s) && !s.startsWith('http'));
ok('sw 预缓存清单非空', precache.length >= 4, precache.join(','));
for (const p of precache) ok(`sw 预缓存项在盘上: ${p}`, fs.existsSync(path.join(ROOT, p)));
ok('sw 缓存名带版本号', /['"`][\w-]*-v\d+/.test(swSrc), (swSrc.match(/minesweeper-v\d+/) || ['-'])[0]);
// 注意：「网络优先」「file:// 不注册」这两件事以前是 grep 断言，实测把 sw 改成 cache-first、
// 把注册的 protocol 守卫删掉，两条 grep 都照样绿（`fetch(req)` 在 install 段就出现过；
// protocol 字符串留在上一行）。所以它们已经改成下面 B 段的行为断言。
ok('sw 只接管同源', /url\.origin\s*!==\s*self\.location\.origin/.test(swSrc));
ok('sw 只接管 GET', /req\.method\s*!==\s*'GET'/.test(swSrc));

// ---------------------------------------------------------------- B. sw 运行时
class Req {
  constructor(url, opts = {}) {
    this.url = String(url); this.method = opts.method || 'GET'; this.mode = opts.mode || 'cors';
  }
  clone() { return new Req(this.url, { method: this.method, mode: this.mode }); }
}
class Res {
  constructor(body, opts = {}) {
    this.body = body; this.status = opts.status || 200; this.ok = this.status < 400;
    this.type = opts.type || 'basic';
    // 真实 Response 的 headers 有 .get()；stub 必须一样，否则这条断言是空的。
    const h = new Map();
    for (const [k, v] of Object.entries(opts.headers || {})) h.set(k.toLowerCase(), v);
    this.headers = { get: (k) => h.get(String(k).toLowerCase()), entries: () => h.entries() };
  }
  clone() { return this; }
}
class Bucket extends Map {
  async put(req, res) { this.set(typeof req === 'string' ? req : req.url, res); }
  // 与真的 Cache.match 一样：字符串按 sw.js 的位置解析，命中装的是绝对键的桶。
  async match(req) {
    const key = typeof req === 'string' ? new URL(req, sandbox.location.href).href : req.url;
    return this.get(key);
  }
  // 真的 Cache.addAll 自己会去抓 URL，并把相对路径按 sw.js 的位置解析成绝对键。
  // 少了这个方法，install 一调就抛 TypeError，B 段整段跑不到——而 A 段的 FAIL 看起来
  // 像是「预缓存清单是空的」，实际是台架自己缺了一条标准 API。
  async addAll(reqs) {
    for (const spec of reqs) {
      const url = new URL(spec, sandbox.location.href).href;
      await this.put(url, await sandbox.fetch(url));
    }
  }
}
const buckets = new Map();
const caches = {
  async open(name) { if (!buckets.has(name)) buckets.set(name, new Bucket()); return buckets.get(name); },
  async keys() { return [...buckets.keys()]; },
  async delete(name) { return buckets.delete(name); },
  async match(req) {
    const key = typeof req === 'string' ? new URL(req, sandbox.location.href).href : req.url;
    for (const b of buckets.values()) if (b.has(key)) return b.get(key);
    return undefined;
  },
};
let online = true, served = [], skipped = false, claimed = false;
const listeners = {};
const sandbox = {
  console, URL, Promise, Response: Res, Request: Req, TypeError, caches,
  async fetch(input) {
    const url = typeof input === 'string' ? input : input.url;
    served.push(url);
    if (!online) throw new TypeError('Failed to fetch');
    return new Res('<' + url.split('/').pop() + '>');
  },
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  location: { origin: 'https://example.dev', href: 'https://example.dev/sw.js' },
  async skipWaiting() { skipped = true; },
  clients: { async claim() { claimed = true; } },
};
sandbox.self = sandbox;
sandbox.registration = { scope: 'https://example.dev/' };
vm.runInContext(swSrc, vm.createContext(sandbox), { filename: 'sw.js' });

const fire = async (type, evt = {}) => {
  let done;
  evt.waitUntil = (p) => { done = p; };
  for (const fn of (listeners[type] || [])) await fn(evt);
  if (done) await done;
  return evt;
};
const grab = async (req) => {
  let p;
  await fire('fetch', { request: req, respondWith: (x) => { p = x; } });
  return p;
};
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

await fire('install', {});
ok('install 完成且 skipWaiting', skipped);
const shell = buckets.get([...buckets.keys()][0]);
ok('install 预热了外壳', shell && shell.size >= 4, 'shell=' + (shell && shell.size));
ok('缓存键已解析为绝对 URL', [...shell.keys()].every((k) => k.startsWith('https://')), [...shell.keys()][0]);
ok('预缓存全部命中（清单不是空话）', precache.every((p) =>
  ['https://example.dev/', 'https://example.dev/index.html'].includes('https://example.dev/' + p)
  || shell.has('https://example.dev/' + p) || served.includes('https://example.dev/' + p)),
precache.filter((p) => !shell.has('https://example.dev/' + p) && !served.includes('https://example.dev/' + p)).join(','));

served = [];
let res = await grab(new Req('https://example.dev/js/main.js', { mode: 'no-cors' }));
ok('在线真的打到网络', served.length === 1 && (await res).body === '<main.js>');
await settle();
ok('在线响应回填进缓存', shell.has('https://example.dev/js/main.js')
  || [...buckets.values()].some((b) => b.has('https://example.dev/js/main.js')));

online = false;
res = await grab(new Req('https://example.dev/css/game.css'));
ok('断网命中缓存', (await res).body === '<game.css>');
res = await grab(new Req('https://example.dev/anything.html', { mode: 'navigate' }));
ok('离线导航回落 index.html', (await res).body === '<index.html>');
res = await grab(new Req('https://example.dev/never-cache.png'));
const miss = await res;
ok('未命中返回响应而非抛异常', !!miss && typeof miss.status === 'number', 'status=' + (miss && miss.status));
ok('503 离线页带 html 头', miss.status === 503 && /text\/html/.test(String(miss.headers.get('Content-Type'))));

online = true;
let touched = false;
await fire('fetch', { request: new Req('https://cdn.other.dev/font.css'), respondWith: () => { touched = true; } });
ok('跨域不接管', !touched);
touched = false;
await fire('fetch', { request: new Req('https://example.dev/x', { method: 'POST' }), respondWith: () => { touched = true; } });
ok('非 GET 不接管', !touched);

await caches.open('minesweeper-v0-shell');
await caches.open('junk-from-another-era');
await fire('activate', {});
ok('activate 清了旧版本缓存', (await caches.keys()).every((k) => /minesweeper-v\d+-(shell|assets)$/.test(k)),
  (await caches.keys()).join(','));
ok('activate 认领了 clients', claimed);

// 网络优先的正证：把同一 URL 塞一份"旧版本"进缓存，联网再取。
// cache-first 实现在这里必然拿到 stale —— 这才是"改了代码不会被旧缓存钉住"的实测。
online = true;
const staleUrl = 'https://example.dev/js/render/board.js';
(await caches.open('minesweeper-v1-assets')).set(staleUrl, new Res('<board-STALE.js>'));
served = [];
const freshest = await (await grab(new Req(staleUrl)));
ok('缓存里有旧的也要走网络（网络优先）', freshest.body === '<board.js>' && served.length === 1,
  'got=' + freshest.body + ' served=' + served.length);
await settle();
ok('新响应覆盖陈旧缓存', (await caches.match(staleUrl)).body === '<board.js>',
  'now=' + (await caches.match(staleUrl)).body);

// C. 注册脚本：file://（Electron 双击 index.html 就是 file://）不许注册、不许抛红
const regSrc = read('js/sw-register.js').toString('utf8');
const html2 = html;
ok('注册脚本被 index.html 引用', /<script[^>]+sw-register\.js/.test(html2));
process.on('unhandledRejection', () => { regUncaught++; });
let regUncaught = 0;

async function runRegister(protocol, registerImpl) {
  let calls = 0;
  const handlers = {};
  const sandbox = {
    console, Promise, location: { protocol },
    navigator: { serviceWorker: { register: (...a) => { calls++; return registerImpl(...a); } } },
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInContext(regSrc, vm.createContext(sandbox), { filename: 'sw-register.js' });
  for (const fn of (handlers.load || [])) await fn();
  await settle();
  return { calls, loaded: (handlers.load || []).length };
}
let r = await runRegister('file:', () => Promise.reject(new Error('file:// 不允许注册')));
ok('file:// 下不注册（Electron 直开不抛红）', r.calls === 0, 'calls=' + r.calls);
r = await runRegister('http:', () => Promise.reject(new Error('no SW support')));
ok('http:// 下注册一次', r.calls === 1, 'calls=' + r.calls);
ok('注册被拒时不产生未处理拒绝', regUncaught === 0, 'unhandled=' + regUncaught);
r = await runRegister('https:', () => Promise.resolve({ scope: '/' }));
ok('https:// 下注册一次', r.calls === 1, 'calls=' + r.calls);
const noSw = await (async () => {
  let threw = null;
  const sandbox = { console, Promise, location: { protocol: 'https:' }, navigator: {},
    addEventListener: () => {} };
  sandbox.window = sandbox; sandbox.self = sandbox;
  try { vm.runInContext(regSrc, vm.createContext(sandbox), { filename: 'sw-register.js' }); }
  catch (e) { threw = e.message; }
  return threw;
})();
ok('浏览器没有 serviceWorker 时不崩', noSw === null, String(noSw));

// ---------------------------------------------------------------- D. 自己的服务器要给出能被安装的 MIME
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createServer } = require(path.join(ROOT, 'server.cjs'));
  const server = createServer(ROOT);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const types = {
    '/manifest.webmanifest': ['application/manifest+json', 'application/json'],
    '/sw.js': ['text/javascript', 'application/javascript'],
    '/index.html': ['text/html'],
    '/assets/icons/icon-512.png': ['image/png'],
  };
  for (const [route, want] of Object.entries(types)) {
    let res = null, err = null;
    try { res = await fetch(base + route); } catch (e) { err = e.message; }
    ok(`本地服务器 200: ${route}`, !!res && res.status === 200, err || (res && String(res.status)));
    const ct = String(res && res.headers.get('content-type'));
    // octet-stream 的 manifest 在 Chrome 眼里等于"没有 manifest"，安装提示根本不会出现。
    ok(`MIME 可安装: ${route}`, want.some((w) => ct.startsWith(w)), ct);
  }
  const mfBody = await (await fetch(base + '/manifest.webmanifest')).text();
  ok('服务器上的 manifest 与盘上同一份', JSON.parse(mfBody).start_url === mf.start_url);
  const swBody = await (await fetch(base + '/sw.js')).text();
  ok('服务器上的 sw.js 与盘上同一份', swBody === swSrc);
  await new Promise((r) => server.close(r));

  // 静态服务器的越界读取：把服务器根收窄到 assets/，再用四种写法去要仓根的 package.json。
  // （fetch 会把 /../ 在 URL 层就规范化掉，所以字面 '..' 必须用 %2e%2e 或 %2f 才真打到服务器，
  //   这条断言才有意义 —— 第一版就是栽在这里，测的是 URL 解析而不是服务器的守卫。）
  const marker = '"name": "minesweeper"';
  const nested = createServer(path.join(ROOT, 'assets'));
  await new Promise((r) => nested.listen(0, '127.0.0.1', r));
  const nbase = `http://127.0.0.1:${nested.address().port}`;
  let leaked = [];
  for (const probe of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json',
    '/%2e%2e%2fpackage.json', '/icons/../../package.json', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
    let body = '', code = 'throw';
    try {
      const res = await fetch(nbase + probe);
      code = String(res.status);
      body = res.ok ? await res.text() : '';
    } catch { /* 连接层失败也算没泄漏 */ }
    if (body.includes(marker)) leaked.push(probe + '→' + code);
    ok(`越界探针不返回仓根文件: ${probe}`, !body.includes(marker), code);
  }
  ok('收窄的根仍可正常取图', (await fetch(nbase + '/icons/icon-512.png')).status === 200);
  await new Promise((r) => nested.close(r));
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  pwa: ${pass} pass / ${fail} fail  (manifest ${ (mf.icons || []).length } icons, precache ${precache.length})`);
process.exit(fail ? 1 : 0);
