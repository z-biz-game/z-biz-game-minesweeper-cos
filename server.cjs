// Zero-dependency static server. CommonJS on purpose: package.json is "type": "module"
// so `node --check` parses the browser sources as ES modules, and this file still has to
// be requirable by Electron and by tools/verify.sh.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(root = __dirname) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

function startServer({ port = 5173, root = path.join(__dirname) } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 5173;
  startServer({ port })
    .then((server) => {
      console.log(`扫雷 Minesweeper served at http://127.0.0.1:${port}/  (ctrl+c to stop)`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
