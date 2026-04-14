#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const viewerPath = path.join(projectRoot, 'viewer', 'index.html');
const port = parseInt(process.env.SMAUG_VIEWER_PORT || process.env.PORT || '4313', 10);

function resolvePendingPath(config) {
  const configured = config.pendingFile || './.state/pending-bookmarks.json';
  const expanded = configured.replace(/^~(?=$|\/|\\)/, process.env.HOME || '');
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const config = loadConfig();
  const pendingPath = resolvePendingPath(config);

  if (url.pathname === '/data') {
    try {
      const content = fs.readFileSync(pendingPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(content);
    } catch (error) {
      sendJson(res, 500, {
        error: `Could not read pending file at ${pendingPath}`,
        details: error.message
      });
    }
    return;
  }

  if (url.pathname === '/meta') {
    sendJson(res, 200, {
      pendingFile: pendingPath,
      projectRoot
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendHtml(res, viewerPath);
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Smaug viewer running at http://localhost:${port}`);
  console.log(`Reading pending bookmarks from ${resolvePendingPath(loadConfig())}`);
});
