#!/usr/bin/env node

import http from 'http';
import crypto from 'crypto';
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

function cachePathForUrl(config, value) {
  const previewRoot = resolveConfiguredPath(config, 'linkPreviewCacheDir', './.state/link-previews');
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return path.join(previewRoot, `${hash}.json`);
}

function previewImageCachePaths(config, value) {
  const imageRoot = resolveConfiguredPath(config, 'linkPreviewImageCacheDir', './.state/link-preview-images');
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return {
    imageRoot,
    hash,
    metaPath: path.join(imageRoot, `${hash}.json`)
  };
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlAttr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match ? decodeHtmlEntities(match[1].trim()) : '';
}

function metaContent(html, names) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const name of names) {
    for (const tag of metas) {
      const key = htmlAttr(tag, 'property') || htmlAttr(tag, 'name');
      if (key.toLowerCase() === name) {
        return htmlAttr(tag, 'content');
      }
    }
  }
  return '';
}

function firstExternalLink(links = []) {
  return links.find((link) => {
    try {
      const url = new URL(link);
      return ['http:', 'https:'].includes(url.protocol) && !['x.com', 'twitter.com'].includes(url.hostname.replace(/^www\./, ''));
    } catch {
      return false;
    }
  }) || '';
}

function absoluteUrl(base, value) {
  if (!value) return '';
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

function parseLinkPreview(url, html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = metaContent(html, ['og:title', 'twitter:title']) || (titleMatch ? titleMatch[1] : '');
  const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
  const image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  const siteName = metaContent(html, ['og:site_name', 'twitter:site']);
  const parsed = new URL(url);

  return {
    url,
    title: decodeHtmlEntities(rawTitle).replace(/\s+/g, ' ').trim(),
    description: decodeHtmlEntities(description).replace(/\s+/g, ' ').trim(),
    image: absoluteUrl(url, image),
    siteName: siteName || parsed.hostname.replace(/^www\./, ''),
    hostname: parsed.hostname.replace(/^www\./, '')
  };
}

function contentTypeExtension(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
  }[normalized] || '';
}

async function fetchLinkPreview(config, rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Unsupported preview URL');
  }

  const cachePath = cachePathForUrl(config, url.href);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  const response = await fetch(url.href, {
    redirect: 'follow',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'SmaugArchivePreview/1.0'
    }
  });
  if (!response.ok) {
    throw new Error(`Preview fetch failed with ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    throw new Error('Preview URL did not return HTML');
  }

  const html = await response.text();
  const preview = parseLinkPreview(response.url || url.href, html);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(preview, null, 2));
  return preview;
}

async function sendLinkPreviewImage(res, config, rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Unsupported preview image URL');
    }

    const cache = previewImageCachePaths(config, url.href);
    if (fs.existsSync(cache.metaPath)) {
      const meta = JSON.parse(fs.readFileSync(cache.metaPath, 'utf8'));
      if (fs.existsSync(meta.filePath)) {
        res.writeHead(200, {
          'Content-Type': meta.contentType,
          'Cache-Control': 'public, max-age=86400'
        });
        fs.createReadStream(meta.filePath).pipe(res);
        return;
      }
    }

    const response = await fetch(url.href, {
      redirect: 'follow',
      headers: {
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*',
        'User-Agent': 'SmaugArchivePreview/1.0'
      }
    });
    if (!response.ok) throw new Error(`Image fetch failed with ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    const ext = contentTypeExtension(contentType);
    if (!ext) throw new Error('Preview image URL did not return a supported image');

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(cache.imageRoot, { recursive: true });
    const filePath = path.join(cache.imageRoot, `${cache.hash}${ext}`);
    fs.writeFileSync(filePath, buffer);
    if (!isRasterImage(filePath)) {
      fs.rmSync(filePath, { force: true });
      throw new Error('Preview image was not a raster image');
    }

    const meta = {
      url: response.url || url.href,
      contentType: MIME_TYPES[ext] || contentType.split(';')[0],
      filePath
    };
    fs.writeFileSync(cache.metaPath, JSON.stringify(meta, null, 2));
    res.writeHead(200, {
      'Content-Type': meta.contentType,
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 422, {
      error: 'Could not load preview image',
      details: error.message
    });
  }
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
      const links = [...entry.matchAll(/^- \*\*(?:Link|Media|Quoted|Parent):\*\* (.+)$/gm)]
        .map((match) => match[1].trim());
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
        links,
        previewUrl: firstExternalLink(links)
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

  if (url.pathname === '/link-preview') {
    const target = url.searchParams.get('url') || '';
    fetchLinkPreview(config, target)
      .then((preview) => sendJson(res, 200, preview))
      .catch((error) => sendJson(res, 422, {
        error: 'Could not load link preview',
        details: error.message
      }));
    return;
  }

  if (url.pathname === '/link-preview-image') {
    const target = url.searchParams.get('url') || '';
    sendLinkPreviewImage(res, config, target);
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
