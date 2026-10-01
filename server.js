const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, 'www');
const port = Number(process.env.PORT) || 4354;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const filePath = path.resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    const target = !error && stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(target, (readError, content) => {
      if (readError) {
        response.writeHead(404).end('Not found');
        return;
      }

      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      });
      response.end(content);
    });
  });
}).listen(port, '0.0.0.0', () => {
  console.log(`Flynanz web server listening on port ${port}`);
});