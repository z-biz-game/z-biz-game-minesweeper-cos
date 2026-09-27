// Keeps the renderer's bridge surface empty on purpose: the game gets no Node access,
// so the desktop build cannot drift away from what the browser build can do.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('desktopShell', { platform: process.platform, version: '1.0.0' });
