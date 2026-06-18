import fs from 'fs';
import { loadConfig } from './config.js';
import { classifyBookmark } from './organizer.js';

const DATE_HEADER_RE = /^# ([A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4})$/;
const SECTION_SPLIT_RE = /^# [A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4}$/gm;

function cleanText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function oneLine(value) {
  return cleanText(value).replace(/\s+/g, ' ').trim();
}

function looksLikeHtml(value) {
  const text = oneLine(value).slice(0, 200).toLowerCase();
  return text.startsWith('<!doctype') ||
    text.startsWith('<html') ||
    text.includes('<head') ||
    text.includes('<body') ||
    text.includes('charset=') ||
    text.includes('_next/static');
}

function truncate(value, max = 84) {
  const text = oneLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function quoteLines(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return ['>'];
  return cleaned.split('\n').map((line) => line ? `> ${line}` : '>');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeTitle(value) {
  return oneLine(value).replace(/[`*_#[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function displayTitle(bookmark) {
  const links = bookmark.links || [];
  const contentTitle = links
    .map((link) => link.content?.title)
    .find(Boolean);
  if (contentTitle) return escapeTitle(contentTitle);

  const text = oneLine(bookmark.text);
  const firstSentence = text.match(/^(.{20,160}?[.!?])(?:\s|$)/)?.[1];
  const source = firstSentence || text || bookmark.organization?.section || 'Bookmarked tweet';
  return escapeTitle(truncate(source, 72)) || 'Bookmarked tweet';
}

function summaryFor(bookmark, organization) {
  const links = bookmark.links || [];
  const contentDescription = links
    .map((link) => link.content?.description || link.content?.text)
    .find((value) => value && !looksLikeHtml(value));
  if (contentDescription) return truncate(contentDescription, 260);

  const text = oneLine(bookmark.text);
  if (text) return truncate(text, 260);

  const quoted = oneLine(bookmark.quoteContext?.text);
  if (quoted) return `Quote bookmark highlighting: ${truncate(quoted, 220)}`;

  const mediaCount = (bookmark.mediaRefs || bookmark.media || []).length;
  if (mediaCount > 0) return `Media bookmark routed to ${organization.section}.`;

  return `Bookmark routed to ${organization.section}.`;
}

function mediaLabel(bookmark) {
  const assets = bookmark.mediaAssets || [];
  const refs = bookmark.mediaRefs || bookmark.media || [];
  if (assets.length > 0) {
    const kinds = unique(assets.map((asset) => asset.kind).filter((kind) => kind !== 'error'));
    if (kinds.length > 0) return `Local media evidence available (${kinds.join(', ')}).`;
  }
  if (refs.length > 0) {
    const types = unique(refs.map((ref) => ref.type || 'media'));
    return `Media reference available (${types.join(', ')}).`;
  }
  return null;
}

function linkLines(bookmark) {
  const lines = [];
  const links = unique((bookmark.links || []).map((link) => link.expanded || link.original));
  const mediaUrls = new Set((bookmark.mediaRefs || [])
    .map((ref) => ref.url)
    .filter((url) => url && url.includes('twitter.com/') && /\/(photo|video)\//.test(url)));

  for (const url of links) {
    if (!url || url === bookmark.tweetUrl) continue;
    if (mediaUrls.has(url) || /twitter\.com\/.+\/status\/\d+\/(photo|video)\//.test(url)) {
      lines.push(`- **Media:** ${url}`);
    } else {
      lines.push(`- **Link:** ${url}`);
    }
  }

  return unique(lines);
}

function contextLines(bookmark) {
  const lines = [];
  if (bookmark.quoteContext?.tweetUrl) {
    lines.push(`- **Quoted:** ${bookmark.quoteContext.tweetUrl}`);
  } else if (bookmark.quoteContext?.id) {
    lines.push(`- **Quoted:** https://x.com/${bookmark.quoteContext.author || 'i'}/status/${bookmark.quoteContext.id}`);
  }

  if (bookmark.replyContext?.tweetUrl) {
    lines.push(`- **Parent:** ${bookmark.replyContext.tweetUrl}`);
  } else if (bookmark.replyContext?.id) {
    lines.push(`- **Parent:** https://x.com/${bookmark.replyContext.author || 'i'}/status/${bookmark.replyContext.id}`);
  }
  return lines;
}

function tagLine(bookmark) {
  const tags = unique(bookmark.tags || []);
  if (tags.length === 0) return null;
  return `- **Tags:** ${tags.map((tag) => `[[${tag}]]`).join(' ')}`;
}

function signalLine(organization) {
  const signals = unique((organization.signals || []).filter((signal) => {
    return signal && !['tweet', 'media', 'has-media'].includes(signal);
  })).slice(0, 6);
  if (signals.length === 0) return null;
  return `- **Signals:** ${signals.join(', ')}`;
}

export function formatBookmarkEntry(bookmark) {
  const organization = bookmark.organization || classifyBookmark(bookmark);
  const title = displayTitle(bookmark);
  const lines = [`## @${bookmark.author || 'unknown'} - ${title}`];

  if (bookmark.replyContext?.text) {
    lines.push(...quoteLines(`*Replying to @${bookmark.replyContext.author || 'unknown'}:* ${bookmark.replyContext.text}`));
    lines.push('>');
  }

  lines.push(...quoteLines(bookmark.text || '[media bookmark]'));

  if (bookmark.quoteContext?.text) {
    lines.push('>');
    lines.push(...quoteLines(`*Quoting @${bookmark.quoteContext.author || 'unknown'}:* ${bookmark.quoteContext.text}`));
  }

  lines.push('');
  lines.push(`- **Tweet:** ${bookmark.tweetUrl || `https://x.com/${bookmark.author || 'i'}/status/${bookmark.id}`}`);
  lines.push(...linkLines(bookmark));
  lines.push(...contextLines(bookmark));
  if (tagLine(bookmark)) lines.push(tagLine(bookmark));
  lines.push(`- **Section:** ${organization.section}`);
  if (signalLine(organization)) lines.push(signalLine(organization));
  const media = mediaLabel(bookmark);
  if (media) lines.push(`- **Visual:** ${media}`);
  lines.push(`- **What:** ${summaryFor(bookmark, organization)}`);

  return `${lines.join('\n')}\n`;
}

function parseArchiveSections(text) {
  const matches = [...text.matchAll(SECTION_SPLIT_RE)];
  if (matches.length === 0) {
    return { preamble: text.trim(), sections: new Map() };
  }

  const preamble = text.slice(0, matches[0].index).trim();
  const sections = new Map();

  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const chunk = text.slice(start, end).trim();
    const header = chunk.split('\n', 1)[0];
    const date = header.match(DATE_HEADER_RE)?.[1];
    if (!date) continue;
    const body = chunk.slice(header.length).trim();
    if (!sections.has(date)) sections.set(date, []);
    if (body) sections.get(date).push(body);
  }

  return { preamble, sections };
}

function normalizeSectionBody(parts) {
  return parts
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join('\n\n---\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function mergeArchive(archiveText, entriesByDate) {
  const { preamble, sections } = parseArchiveSections(archiveText);

  for (const [date, entries] of entriesByDate.entries()) {
    if (!sections.has(date)) sections.set(date, []);
    sections.get(date).unshift(entries.map((entry) => cleanText(entry)).join('\n\n---\n\n'));
  }

  const dates = [...sections.keys()].sort((a, b) => Date.parse(b) - Date.parse(a));
  const output = [];
  if (preamble) output.push(preamble);

  for (const date of dates) {
    const body = normalizeSectionBody(sections.get(date));
    if (!body) continue;
    output.push(`# ${date}\n\n${body}`);
  }

  return `${output.join('\n\n---\n\n').trim()}\n`;
}

export function validateArchiveOrder(archiveText) {
  const dates = [...archiveText.matchAll(SECTION_SPLIT_RE)]
    .map((match) => match[0].slice(2));
  const violations = [];
  let previous = Infinity;
  for (const date of dates) {
    const timestamp = Date.parse(date);
    if (Number.isNaN(timestamp)) continue;
    if (timestamp > previous) {
      violations.push(date);
    }
    previous = timestamp;
  }
  return { ok: violations.length === 0, violations };
}

export async function bulkArchivePendingBookmarks(options = {}) {
  const config = loadConfig(options.configPath);
  if (!fs.existsSync(config.pendingFile)) {
    throw new Error(`Pending file not found: ${config.pendingFile}`);
  }

  const pending = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
  const allBookmarks = pending.bookmarks || [];
  const limit = options.limit && options.limit > 0 ? options.limit : allBookmarks.length;
  const selected = allBookmarks.slice(0, limit);
  const selectedIds = new Set(selected.map((bookmark) => bookmark.id));

  const entriesByDate = new Map();
  for (const bookmark of selected) {
    if (!bookmark.organization) bookmark.organization = classifyBookmark(bookmark);
    const date = bookmark.date || new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
    if (!entriesByDate.has(date)) entriesByDate.set(date, []);
    entriesByDate.get(date).push(formatBookmarkEntry(bookmark));
  }

  for (const entries of entriesByDate.values()) {
    entries.reverse();
  }

  const archiveText = fs.existsSync(config.archiveFile)
    ? fs.readFileSync(config.archiveFile, 'utf8')
    : '';
  const mergedArchive = mergeArchive(archiveText, entriesByDate);
  const validation = validateArchiveOrder(mergedArchive);
  if (!validation.ok) {
    throw new Error(`Archive date order validation failed: ${validation.violations.slice(0, 5).join(', ')}`);
  }

  const existingIds = new Set((archiveText.match(/https:\/\/x\.com\/[^/\s]+\/status\/(\d+)/g) || [])
    .map((url) => url.match(/status\/(\d+)/)?.[1])
    .filter(Boolean));
  const archivedSelectedIds = selected.filter((bookmark) => {
    return mergedArchive.includes(`/status/${bookmark.id}`) || existingIds.has(bookmark.id);
  }).length;
  if (archivedSelectedIds !== selected.length) {
    throw new Error(`Archive verification failed: found ${archivedSelectedIds}/${selected.length} selected tweet IDs`);
  }

  const remaining = allBookmarks.filter((bookmark) => !selectedIds.has(bookmark.id));
  const result = {
    archiveFile: config.archiveFile,
    pendingFile: config.pendingFile,
    selected: selected.length,
    remaining: remaining.length,
    dryRun: !!options.dryRun,
    dateSections: entriesByDate.size
  };

  if (options.dryRun) return result;

  fs.writeFileSync(config.archiveFile, mergedArchive);
  fs.writeFileSync(config.pendingFile, JSON.stringify({
    ...pending,
    count: remaining.length,
    bookmarks: remaining
  }, null, 2));

  return result;
}
