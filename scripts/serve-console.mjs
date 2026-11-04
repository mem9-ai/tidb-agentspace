import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createConsoleServer({
  directory,
  apiOrigin = process.env.WORKSPACE_API_ORIGIN,
} = {}) {
  const root =
    directory ||
    process.env.WORKSPACE_CONSOLE_DIRECTORY ||
    fileURLToPath(new URL('../dist/console/', import.meta.url));
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0])) {
        res.writeHead(403);
        res.end('Loopback evaluation only.');
        return;
      }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (
        !['GET', 'HEAD'].includes(req.method) ||
        path.startsWith('/api/') ||
        path === '/openapi.json'
      ) {
        res.writeHead(404);
        res.end('Not found.');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (
        !path.startsWith('/discover/') &&
        !['/robots.txt', '/sitemap.xml', '/llms.txt'].includes(path)
      )
        res.setHeader('X-Robots-Tag', 'noindex');
      if (path === '/config.json' && apiOrigin !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ apiOrigin }));
        return;
      }
      let location = resolve(root, '.' + path);
      if (!location.startsWith(resolve(root) + '/')) location = resolve(root, 'index.html');
      let content;
      try {
        content = await readFile(location);
      } catch {
        if (path.startsWith('/discover/')) {
          try {
            location = resolve(root, '.' + path, 'index.html');
            content = await readFile(location);
          } catch {
            res.writeHead(404);
            res.end('Page not found.');
            return;
          }
        } else {
          if (extname(path)) {
            res.writeHead(404);
            res.end('Not found.');
            return;
          }
          location = resolve(root, 'index.html');
          content = await readFile(location);
        }
      }
      res.writeHead(200, {
        'Content-Type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.txt': 'text/plain; charset=utf-8',
            '.woff2': 'font/woff2',
          }[extname(location)] || 'application/octet-stream',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      res.writeHead(500);
      res.end('Console files unavailable. Build the Console first.');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createConsoleServer();
  const port = Number(process.env.WORKSPACE_CONSOLE_PORT || 4173);
  server.listen(port, '127.0.0.1', () =>
    console.log(`Console: http://127.0.0.1:${server.address().port} (static files only)`),
  );
}
