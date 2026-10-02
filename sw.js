'use strict';
// 网络优先、失败退缓存。故意不做 cache-first：改了代码不会被旧缓存钉住
// （踩过 cache-first 的人都知道那是什么噩梦）。
// 缓存名带版本：改动预缓存结构时把 PIPELINE 递增，activate 会清掉旧版本，
// 否则一个仓里会积出一片永远不消失的 v1/v2/v3。
var PIPELINE = 'minesweeper-v1';
var SHELL = PIPELINE + '-shell';
var ASSETS = PIPELINE + '-assets';
// 首屏必需的最小集合：断网后第二次打开也能成形（不是把整站抄一遍）。
var CORE = [
  'index.html',
  'manifest.webmanifest',
  'css/game.css',
  'js/main.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

// put 的键统一用解析成绝对地址后的 URL，取的时候才能用同一种写法命中。
function keyUrl(reg, href) {
  return new Request(new URL(href, reg.scope).href, { method: 'GET' });
}

self.addEventListener('install', function (e) {
  // 预热只当"顺手"：file://、首次安装时断网、路径不通，都不能让 SW 装不上，
  // 所以每一份抓取失败都只吞掉，绝不 reject 安装事务。
  var reg = self.registration;
  e.waitUntil(Promise.all(CORE.map(function (href) {
    var req = keyUrl(reg, href);
    return fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        return caches.open(SHELL).then(function (c) { return c.put(req, res.clone()); });
      }
      return null;
    }).catch(function () { return null; });
  })).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== ASSETS; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 只接管同源：CDN、统计、第三方字体一律放行，不把别人的响应写进本地缓存。
  if (url.origin !== self.location.origin) return;
  var navigate = req.mode === 'navigate';
  e.respondWith(
    fetch(req).then(function (res) {
      // 只缓存可安全复制的 basic 200：opaque/redirect/206 进缓存是给自己埋雷。
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(navigate ? SHELL : ASSETS)
          .then(function (c) { c.put(req, copy); })
          .catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (!navigate) return null;
        // 导航请求单独回落到外壳里的 index.html，让离线打开不白屏。
        var reg = self.registration;
        return caches.open(SHELL).then(function (c) {
          return c.match(keyUrl(reg, 'index.html')) || c.match(keyUrl(reg, './')) || null;
        });
      }).then(function (found) {
        return found || new Response(
          '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">' +
          '<title>扫雷 · 需要联网一次</title>' +
          '<p style="font:16px/1.7 system-ui;color:#F5F5F7;background:#0F0F0F;padding:24px">' +
          '首次打开需要联网；之后断网也能从缓存启动。</p></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      });
    })
  );
});
