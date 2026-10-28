'use strict';
// 离线可用 + 永不被旧缓存钉住。
//
// 两条实测换来的口径：
//   1) 一律 **网络优先**，命中网络才回填缓存。手工 VERSION + cache-first 的组合，
//      发出去的 HTML 会配上上一版的 js/css，出一个"新界面配旧逻辑"的鬼状态，
//      而且玩家自己无法恢复（只能等缓存过期）。
//   2) 缓存名带版本号（activate 时清掉非本版的名字）。改版**不需要**同步 bump：
//      同名文件重绘之后，网络优先这一条保证客户端下一次联网就拿到新字节。
const VERSION = 'minesweeper-v1';
const CACHE = `${VERSION}-shell`;
const PRECACHE = [
  'index.html',
  'manifest.webmanifest',
  'css/game.css',
  'css/studio.css',
  'js/main.js',
  'js/sw-register.js',
];

self.addEventListener('install', (ev) => {
  // 外壳（HTML/manifest/两份 CSS/入口脚本）先抓下来：断网时至少能打开界面，
  // 而不是浏览器的错误页。模块图里的其余文件仍由网络优先那一路按需回填。
  ev.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求（地址栏/刷新/桌面图标）离线时回落到缓存的那份壳，不白屏。
        if (req.mode === 'navigate') {
          const shell = await caches.match('index.html');
          if (shell) return shell;
        }
        // 连壳都没缓存：给一句人话，而不是 Response.error() 那个状态 0 的
        // 网络错误——它在 DevTools 里和"服务器挂了"长得一模一样。
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>离线</title><p>现在离线，这一页也没有缓存。</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
  );
});
