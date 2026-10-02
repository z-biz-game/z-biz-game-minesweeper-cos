'use strict';
// PWA 注册：只在 http(s) 下做。file://（Electron 直接打开、本地双击 index.html）拿不到
// serviceWorker 注册权限，那不是玩家的错，静默跳过，不在控制台抛红。
(function () {
  var http = location.protocol === 'http:' || location.protocol === 'https:';
  if (!http || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {
      // 注册失败（无 SW 支持的旧 Safari、无痕窗口）不影响游戏，玩家照常能玩。
    });
  });
})();
