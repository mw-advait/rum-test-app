const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 3456;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const assetType = url.searchParams.get('asset');

    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    // Inject asset tags into <head> so they load during page load
    // (document-load instrumentation captures these as resource.script/resource.css spans)
    if (assetType) {
      const size = url.searchParams.get('size') || '600';
      const delay = url.searchParams.get('delay') || '350';
      let inject = '';

      if (assetType === 'both') {
        inject += `<script src="/assets/small-compressed.js"></script>\n`;
      }
      if (assetType === 'js' || assetType === 'both') {
        inject += `<script src="/assets/large-uncompressed.js?size=${size}&delay=${delay}"></script>\n`;
      }
      if (assetType === 'css' || assetType === 'both') {
        inject += `<link rel="stylesheet" href="/assets/large-uncompressed.css?size=${size}&delay=${delay}">\n`;
      }
      // /echo20 loaded as a page-load resource (document-load instrumentation ignores
      // fetch/xhr initiators, so it has to come from an HTML element to get a resource span)
      if (assetType === 'echo') {
        inject += `<script src="/echo20?size=${size}&delay=${delay}"></script>\n`;
      }
      // HTTP/1.1 Overhead: many same-host scripts at once. Chrome opens only 6 connections per
      // host on HTTP/1.1, so everything past the 6th waits ~delay ms before its request is sent
      // (requestStart - fetchStart). The detector needs >= 5 requests queued >= 500ms.
      if (assetType === 'overhead') {
        const count = parseInt(url.searchParams.get('count') || '12', 10);
        for (let i = 0; i < count; i++) {
          inject += `<script async src="/assets/slow.js?i=${i}&delay=${delay}"></script>\n`;
        }
      }
      // Large Render Blocking Asset: the ~1.5MB CSS in <head> blocks first paint. With a long
      // delay it dominates FCP (detector needs >= 1MB, FCP 2-10s, asset >= 33% of FCP).
      if (assetType === 'blocking') {
        inject += `<link rel="stylesheet" href="/assets/large-uncompressed.css?delay=${delay}">\n`;
      }

      html = html.replace('</head>', inject + '</head>');
    }

    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html).toString() });
    res.end(html);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, traceparent, tracestate',
    });
    res.end();
    return;
  }

  // Serve real large uncompressed JS file (assets/large-bundle.js, ~927KB)
  if (req.url.startsWith('/assets/large-uncompressed.js')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const delayMs = parseInt(url.searchParams.get('delay') || '350', 10);
    const filePath = path.join(__dirname, 'assets', 'large-bundle.js');
    const body = fs.readFileSync(filePath);

    sleep(delayMs).then(() => {
      console.log(`GET /assets/large-uncompressed.js — ${(body.length / 1024).toFixed(1)}KB real file, ${delayMs}ms delay`);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': body.length.toString(),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    return;
  }

  // Serve real large uncompressed CSS file (assets/large-styles.css, ~1.5MB)
  if (req.url.startsWith('/assets/large-uncompressed.css')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const delayMs = parseInt(url.searchParams.get('delay') || '350', 10);
    const filePath = path.join(__dirname, 'assets', 'large-styles.css');
    const body = fs.readFileSync(filePath);

    sleep(delayMs).then(() => {
      console.log(`GET /assets/large-uncompressed.css — ${(body.length / 1024).toFixed(1)}KB real file, ${delayMs}ms delay`);
      res.writeHead(200, {
        'Content-Type': 'text/css',
        'Content-Length': body.length.toString(),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    return;
  }

  // Tiny script served after a delay - used by the HTTP/1.1 Overhead test (many parallel requests)
  if (req.url.startsWith('/assets/slow.js')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const delayMs = parseInt(url.searchParams.get('delay') || '2000', 10);
    const i = url.searchParams.get('i') || '0';
    const body = `window.__slow = (window.__slow || 0) + 1; // chunk ${i}\n`;
    sleep(delayMs).then(() => {
      console.log(`GET /assets/slow.js?i=${i} — ${delayMs}ms delay`);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': Buffer.byteLength(body).toString(),
        'Access-Control-Allow-Origin': '*',
        'Timing-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    return;
  }

  // Serve real small JS file with gzip compression (proves browser supports compression)
  if (req.url.startsWith('/assets/small-compressed.js')) {
    const filePath = path.join(__dirname, 'assets', 'small-lib.js');
    const body = fs.readFileSync(filePath);
    zlib.gzip(body, (err, compressed) => {
      if (err) { res.writeHead(500); res.end(); return; }
      console.log(`GET /assets/small-compressed.js — ${body.length}B original, ${compressed.length}B gzipped`);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length.toString(),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(compressed);
    });
    return;
  }

  if (req.url.startsWith('/echo20')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const respSizeKb = parseInt(url.searchParams.get('size') || '350', 10);
    const delayMs = parseInt(url.searchParams.get('delay') || '150', 10);

    let size = 0;
    req.on('data', chunk => { size += chunk.length; });
    req.on('end', () => {
      sleep(delayMs).then(() => {
        const targetBytes = respSizeKb * 1024;
        const respBody = '{"ok":true,"pad":"' + 'X'.repeat(targetBytes - 20) + '"}';
        console.log(`${req.method} /echo — ${(size / 1024).toFixed(1)}KB in, ${(Buffer.byteLength(respBody) / 1024).toFixed(1)}KB out, ${delayMs}ms delay`);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(respBody).toString(),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(respBody);
      });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`RUM large-payload test server running at http://localhost:${PORT}`);
});
