const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const indexPath = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    fs.stat(indexPath, (err, stat) => {
      const ready = !err && stat.size > 10000;
      res.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({
        ok: ready,
        service: 'factory-os-v2',
        htmlBytes: ready ? stat.size : 0
      }));
    });
    return;
  }

  if (req.url === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }

  if (req.url === '/' || req.url.startsWith('/?')) {
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        console.error('Failed to read index.html', err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Factory OS failed to load.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, host, () => {
  console.log(`Factory OS v2 listening on ${host}:${port}`);
});
