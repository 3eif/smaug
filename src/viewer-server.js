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

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function resolveConfiguredPath(config, key, fallback) {
  const configured = config[key] || fallback;
  const expanded = configured.replace(/^~(?=$|\/|\\)/, process.env.HOME || '');
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

function isRasterImage(filePath) {
  let fd;
  try {
    const header = Buffer.alloc(12);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 4) return false;

    const ascii = header.toString('ascii', 0, bytesRead);
    return (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
      || (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47)
      || ascii.startsWith('GIF87a')
      || ascii.startsWith('GIF89a')
      || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function localMediaForId(config, id) {
  const mediaRoot = resolveConfiguredPath(config, 'mediaCacheDir', './.state/media');
  const safeId = String(id || '').match(/^\d+$/)?.[0];
  if (!safeId) return [];

  const dir = path.join(mediaRoot, safeId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => MIME_TYPES[path.extname(name).toLowerCase()])
    .filter((name) => isRasterImage(path.join(dir, name)))
    .sort((a, b) => {
      const aFrame = a.includes('frame') ? 1 : 0;
      const bFrame = b.includes('frame') ? 1 : 0;
      return aFrame - bFrame || a.localeCompare(b);
    })
    .slice(0, 4)
    .map((name) => `/media/${safeId}/${encodeURIComponent(name)}`);
}

function parseArchive(markdown, config) {
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

      const id = meta.Tweet?.match(/status\/(\d+)/)?.[1] || `${date}-${j}`;
      sections.push({
        id,
        date,
        author: entryMatches[j][1],
        title: entryMatches[j][2].trim(),
        text: quote,
        tweet: meta.Tweet || '',
        section: meta.Section || 'Unsorted',
        what: meta.What || '',
        visual: meta.Visual || '',
        media: localMediaForId(config, id),
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

function sendMedia(res, config, pathname) {
  const match = pathname.match(/^\/media\/(\d+)\/([^/]+)$/);
  if (!match) {
    sendJson(res, 404, { error: 'Media not found' });
    return;
  }

  const mediaRoot = resolveConfiguredPath(config, 'mediaCacheDir', './.state/media');
  const filename = decodeURIComponent(match[2]);
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    sendJson(res, 400, { error: 'Invalid media path' });
    return;
  }

  const filePath = path.join(mediaRoot, match[1], filename);
  const relative = path.relative(mediaRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath) || !isRasterImage(filePath)) {
    sendJson(res, 404, { error: 'Media not found' });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const config = loadConfig();
  const archivePath = resolveConfiguredPath(config, 'archiveFile', './bookmarks.md');

  if (url.pathname === '/data') {
    try {
      const content = fs.readFileSync(archivePath, 'utf8');
      sendJson(res, 200, parseArchive(content, config));
    } catch (error) {
      sendJson(res, 500, {
        error: `Could not read archive file at ${archivePath}`,
        details: error.message
      });
    }
    return;
  }

  if (url.pathname.startsWith('/media/')) {
    sendMedia(res, config, url.pathname);
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
