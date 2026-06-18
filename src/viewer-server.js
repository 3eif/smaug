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

function resolveConfiguredPath(config, key, fallback) {
  const configured = config[key] || fallback;
  const expanded = configured.replace(/^~(?=$|\/|\\)/, process.env.HOME || '');
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

function parseArchive(markdown) {
  const sections = [];
  const dateMatches = [...markdown.matchAll(/^# ([^\n]+)$/gm)];

  for (let i = 0; i < dateMatches.length; i += 1) {
    const date = dateMatches[i][1].trim();
    const start = dateMatches[i].index + dateMatches[i][0].length;
    const end = i + 1 < dateMatches.length ? dateMatches[i + 1].index : markdown.length;
    const dateBody = markdown.slice(start, end);
    const entryMatches = [...dateBody.matchAll(/^## @(.+?) - ([^\n]+)$/gm)];

    for (let j = 0; j < entryMatches.length; j += 1) {
      const entryStart = entryMatches[j].index;
      const entryEnd = j + 1 < entryMatches.length ? entryMatches[j + 1].index : dateBody.length;
      const entry = dateBody.slice(entryStart, entryEnd).trim();
      const meta = Object.fromEntries([...entry.matchAll(/^- \*\*([^:]+):\*\* (.+)$/gm)]
        .map((match) => [match[1], match[2].trim()]));
      const quote = entry
        .split('\n')
        .filter((line) => line.startsWith('>'))
        .map((line) => line.replace(/^>\s?/, ''))
        .join('\n')
        .trim();

      sections.push({
        id: meta.Tweet?.match(/status\/(\d+)/)?.[1] || `${date}-${j}`,
        date,
        author: entryMatches[j][1],
        title: entryMatches[j][2].trim(),
        text: quote,
        tweet: meta.Tweet || '',
        section: meta.Section || 'Unsorted',
        what: meta.What || '',
        visual: meta.Visual || '',
        links: [...entry.matchAll(/^- \*\*(?:Link|Media|Quoted|Parent):\*\* (.+)$/gm)]
          .map((match) => match[1].trim())
      });
    }
  }

  const categories = [...sections.reduce((map, item) => {
    map.set(item.section, (map.get(item.section) || 0) + 1);
    return map;
  }, new Map()).entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    count: sections.length,
    categories,
    bookmarks: sections
  };
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
  const archivePath = resolveConfiguredPath(config, 'archiveFile', './bookmarks.md');

  if (url.pathname === '/data') {
    try {
      const content = fs.readFileSync(archivePath, 'utf8');
      sendJson(res, 200, parseArchive(content));
    } catch (error) {
      sendJson(res, 500, {
        error: `Could not read archive file at ${archivePath}`,
        details: error.message
      });
    }
    return;
  }

  if (url.pathname === '/meta') {
    sendJson(res, 200, {
      archiveFile: archivePath,
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
  console.log(`Reading archive from ${resolveConfiguredPath(loadConfig(), 'archiveFile', './bookmarks.md')}`);
});
