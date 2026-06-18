import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { fetchTweet } from './processor.js';

const DEFAULT_SECTIONS = {
  ai_tools: 'AI Tools and Agents',
  coding_reference: 'Coding Reference',
  design_ui: 'Design and UI Patterns',
  visual_reference: 'Visual Reference',
  product_startup: 'Product and Startup Ideas',
  research_papers: 'Research Papers',
  articles_essays: 'Articles and Essays',
  videos: 'Videos and Demos',
  memes_culture: 'Memes and Culture',
  philosophy_life: 'Philosophy and Life',
  politics_news: 'Politics and News',
  health_fitness: 'Health and Fitness',
  music_media: 'Music and Media',
  plain_tweets: 'Plain Tweets'
};

const KEYWORDS = {
  ai_tools: [
    'ai', 'agent', 'agents', 'codex', 'claude', 'openai', 'anthropic', 'llm',
    'prompt', 'model', 'chatgpt', 'cursor', 'mcp', 'workflow', 'automation'
  ],
  coding_reference: [
    'github', 'repo', 'code', 'swift', 'swiftui', 'react', 'typescript',
    'javascript', 'python', 'rust', 'xcode', 'api', 'library', 'framework',
    'plugin', 'skill', 'developer', 'terminal', 'cli'
  ],
  design_ui: [
    'design', 'ui', 'ux', 'animation', 'interface', 'interaction', 'layout',
    'prototype', 'figma', 'motion', 'glass', 'app', 'ios', 'component'
  ],
  product_startup: [
    'startup', 'product', 'saas', 'revenue', 'growth', 'founder', 'business',
    'launch', 'customers', 'marketing', 'b2b', 'funding'
  ],
  research_papers: [
    'arxiv', 'paper', 'research', 'study', 'model', 'benchmark', 'evaluation',
    'dataset', 'scholar'
  ],
  philosophy_life: [
    'philosophy', 'life', 'meaning', 'love', 'mind', 'soul', 'wisdom',
    'discipline', 'habit', 'attention', 'beautiful'
  ],
  politics_news: [
    'election', 'policy', 'government', 'war', 'news', 'politics', 'court',
    'congress', 'president'
  ],
  health_fitness: [
    'health', 'medical', 'fitness', 'workout', 'diet', 'sleep', 'doctor',
    'medicine', 'body'
  ],
  music_media: [
    'music', 'album', 'song', 'film', 'movie', 'cinema', 'sound', 'video',
    'trailer'
  ],
  memes_culture: [
    'meme', 'lol', 'funny', 'shitpost', 'culture', 'viral'
  ]
};

function normalize(value) {
  return String(value || '').toLowerCase();
}

function linkDomains(bookmark) {
  return (bookmark.links || [])
    .map((link) => {
      try {
        return new URL(link.expanded || link.original).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function scoreKeywords(text, keywords) {
  return keywords.reduce((score, keyword) => {
    return score + (text.includes(keyword.toLowerCase()) ? 1 : 0);
  }, 0);
}

export function inferMediaRefs(bookmark) {
  const refs = [];

  for (const media of bookmark.media || []) {
    refs.push({
      source: 'tweet-media',
      tweetId: bookmark.id,
      type: media.type || 'media',
      url: media.url || media.previewUrl || media.videoUrl || null,
      previewUrl: media.previewUrl || null,
      videoUrl: media.videoUrl || null,
      width: media.width || null,
      height: media.height || null,
      durationMs: media.durationMs || null
    });
  }

  for (const media of bookmark.quoteContext?.media || []) {
    refs.push({
      source: 'quote-media',
      tweetId: bookmark.quoteContext.id,
      type: media.type || 'media',
      url: media.url || media.previewUrl || media.videoUrl || null,
      previewUrl: media.previewUrl || null,
      videoUrl: media.videoUrl || null,
      width: media.width || null,
      height: media.height || null,
      durationMs: media.durationMs || null
    });
  }

  for (const media of bookmark.replyContext?.media || []) {
    refs.push({
      source: 'reply-media',
      tweetId: bookmark.replyContext.id,
      type: media.type || 'media',
      url: media.url || media.previewUrl || media.videoUrl || null,
      previewUrl: media.previewUrl || null,
      videoUrl: media.videoUrl || null,
      width: media.width || null,
      height: media.height || null,
      durationMs: media.durationMs || null
    });
  }

  for (const link of bookmark.links || []) {
    if (link.type !== 'media' && link.type !== 'image') continue;
    const tweetId = extractTweetId(link.expanded || link.original) || bookmark.id;
    refs.push({
      source: 'media-link',
      tweetId,
      type: link.expanded?.includes('/video/') ? 'video' : link.type,
      url: link.expanded || link.original,
      previewUrl: null,
      videoUrl: null,
      width: null,
      height: null,
      durationMs: null
    });
  }

  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.source}:${ref.tweetId}:${ref.type}:${ref.url || ref.previewUrl || ref.videoUrl}`;
    byKey.set(key, ref);
  }
  return [...byKey.values()];
}

export function extractTweetId(url) {
  const match = String(url || '').match(/status\/(\d+)/);
  return match?.[1] || null;
}

export function classifyBookmark(bookmark) {
  const domains = linkDomains(bookmark);
  const linkTypes = (bookmark.links || []).map((link) => link.type);
  const mediaRefs = inferMediaRefs(bookmark);
  const text = normalize([
    bookmark.text,
    bookmark.author,
    bookmark.authorName,
    bookmark.quoteContext?.text,
    bookmark.replyContext?.text,
    domains.join(' '),
    linkTypes.join(' '),
    (bookmark.links || []).map((link) => link.content?.title || link.content?.description || '').join(' ')
  ].join(' '));

  const scores = {};
  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    scores[category] = scoreKeywords(text, keywords);
  }

  if (linkTypes.includes('github')) scores.coding_reference += 5;
  if (linkTypes.includes('x-article')) scores.articles_essays += 3;
  if (linkTypes.includes('article')) scores.articles_essays += 2;
  if (linkTypes.includes('video')) scores.videos += 3;
  if (linkTypes.includes('media') || linkTypes.includes('image') || mediaRefs.length > 0) {
    scores.visual_reference += 2;
  }
  if (domains.some((d) => d.includes('arxiv.org'))) scores.research_papers += 6;
  if (domains.some((d) => d.includes('youtube.com') || d.includes('youtu.be'))) scores.videos += 4;
  if (domains.some((d) => d.includes('github.com'))) scores.coding_reference += 4;
  if (domains.some((d) => d.includes('figma.com') || d.includes('dribbble.com') || d.includes('awwwards.com'))) {
    scores.design_ui += 4;
  }

  let category = 'plain_tweets';
  let score = 0;
  for (const [candidate, candidateScore] of Object.entries(scores)) {
    if (candidateScore > score) {
      category = candidate;
      score = candidateScore;
    }
  }

  const needsMediaAnalysis = mediaRefs.length > 0;
  if (score === 0 && needsMediaAnalysis) category = 'visual_reference';

  const signals = [
    ...new Set([
      ...domains.slice(0, 6),
      ...linkTypes,
      ...(needsMediaAnalysis ? ['has-media'] : []),
      ...(bookmark.isQuote ? ['quote'] : []),
      ...(bookmark.isReply ? ['reply'] : [])
    ].filter(Boolean))
  ];

  return {
    category,
    section: DEFAULT_SECTIONS[category] || DEFAULT_SECTIONS.plain_tweets,
    confidence: Math.min(1, Math.max(0.25, score / 8)),
    signals,
    needsMediaAnalysis,
    rationale: buildRationale(category, signals)
  };
}

function buildRationale(category, signals) {
  const reason = signals.length ? `signals: ${signals.slice(0, 5).join(', ')}` : 'fallback classification';
  return `${DEFAULT_SECTIONS[category] || 'Bookmark'} based on ${reason}`;
}

function mediaFilename(ref, index) {
  const url = ref.type === 'video' ? (ref.previewUrl || ref.url || ref.videoUrl) : (ref.url || ref.previewUrl);
  let ext = '.jpg';
  try {
    const pathname = new URL(url).pathname;
    const found = pathname.match(/\.(jpg|jpeg|png|gif|webp)$/i)?.[0];
    if (found) ext = found.toLowerCase();
  } catch {}
  const type = ref.type || 'media';
  return `${String(index + 1).padStart(2, '0')}-${type}${ext}`;
}

async function downloadMediaAsset(ref, targetDir, index) {
  const sourceUrl = ref.type === 'video'
    ? (ref.previewUrl || ref.url || ref.videoUrl)
    : (ref.url || ref.previewUrl);
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

  fs.mkdirSync(targetDir, { recursive: true });
  const localPath = path.join(targetDir, mediaFilename(ref, index));
  if (!fs.existsSync(localPath)) {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`media download failed ${response.status} for ${sourceUrl}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
  }

  return {
    kind: ref.type === 'video' ? 'video-thumbnail' : 'image',
    source: ref.source,
    sourceUrl,
    localPath,
    width: ref.width || null,
    height: ref.height || null,
    durationMs: ref.durationMs || null,
    videoUrl: ref.videoUrl || null
  };
}

async function hydrateMediaRefs(bookmark, config, options) {
  let refs = inferMediaRefs(bookmark);
  const missingDirectMedia = refs.some((ref) => ref.source === 'media-link' && !ref.previewUrl && !ref.videoUrl);

  if (options.fetchMedia && missingDirectMedia) {
    const tweetIds = [...new Set(refs.map((ref) => ref.tweetId).filter(Boolean))];
    for (const tweetId of tweetIds) {
      if (options.birdDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.birdDelayMs));
      }
      let tweet = null;
      try {
        tweet = await fetchTweet(config, tweetId);
      } catch (error) {
        refs.push({
          source: 'media-hydration-error',
          tweetId,
          type: 'error',
          url: null,
          previewUrl: null,
          videoUrl: null,
          width: null,
          height: null,
          durationMs: null,
          error: error.message
        });
        continue;
      }

      for (const media of tweet?.media || []) {
        refs.push({
          source: tweetId === String(bookmark.id) ? 'tweet-media' : 'linked-tweet-media',
          tweetId,
          type: media.type || 'media',
          url: media.url || media.previewUrl || media.videoUrl || null,
          previewUrl: media.previewUrl || null,
          videoUrl: media.videoUrl || null,
          width: media.width || null,
          height: media.height || null,
          durationMs: media.durationMs || null
        });
      }
    }
  }

  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.tweetId}:${ref.type}:${ref.url || ref.previewUrl || ref.videoUrl}`;
    byKey.set(key, ref);
  }
  refs = [...byKey.values()];

  let assets = bookmark.mediaAssets || [];
  if (options.downloadMedia && refs.length > 0) {
    const targetDir = path.join(config.mediaCacheDir || './.state/media', String(bookmark.id));
    const downloaded = [];
    for (const [index, ref] of refs.entries()) {
      try {
        const asset = await downloadMediaAsset(ref, targetDir, index);
        if (asset) downloaded.push(asset);
      } catch (error) {
        downloaded.push({
          kind: 'error',
          source: ref.source,
          sourceUrl: ref.url || ref.previewUrl || ref.videoUrl,
          error: error.message
        });
      }
    }
    assets = downloaded;
  }

  return { refs, assets };
}

export async function enrichPendingBookmarks(options = {}) {
  const config = loadConfig(options.configPath);
  const pendingPath = config.pendingFile;
  if (!fs.existsSync(pendingPath)) {
    throw new Error(`Pending file not found: ${pendingPath}`);
  }

  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  const limit = options.limit && options.limit > 0 ? options.limit : null;
  const bookmarks = pending.bookmarks || [];
  const toEnrich = limit
    ? (options.latest ? bookmarks.slice(-limit) : bookmarks.slice(0, limit))
    : bookmarks;
  const force = !!options.force;

  let changed = 0;
  let mediaHydrated = 0;
  for (const bookmark of toEnrich) {
    const before = JSON.stringify({
      organization: bookmark.organization,
      mediaRefs: bookmark.mediaRefs,
      mediaAssets: bookmark.mediaAssets,
      mediaAnalysis: bookmark.mediaAnalysis
    });

    if (force || !bookmark.organization) {
      bookmark.organization = classifyBookmark(bookmark);
    }

    if (force || options.fetchMedia || options.downloadMedia || !bookmark.mediaRefs) {
      const { refs, assets } = await hydrateMediaRefs(bookmark, config, {
        fetchMedia: !!options.fetchMedia,
        downloadMedia: !!options.downloadMedia,
        birdDelayMs: Math.max(0, parseInt(options.birdDelayMs || 0, 10) || 0)
      });
      bookmark.mediaRefs = refs;
      bookmark.mediaAssets = assets;
      if (refs.length > 0) mediaHydrated += 1;
    }

    if (!bookmark.mediaAnalysis) {
      bookmark.mediaAnalysis = {
        status: bookmark.organization?.needsMediaAnalysis ? 'needs-analysis' : 'not-needed',
        summary: null,
        labels: []
      };
    }

    const after = JSON.stringify({
      organization: bookmark.organization,
      mediaRefs: bookmark.mediaRefs,
      mediaAssets: bookmark.mediaAssets,
      mediaAnalysis: bookmark.mediaAnalysis
    });
    if (before !== after) changed += 1;
  }

  const output = {
    ...pending,
    enrichedAt: new Date().toISOString(),
    count: bookmarks.length,
    bookmarks
  };
  fs.writeFileSync(pendingPath, JSON.stringify(output, null, 2));

  return {
    pendingFile: pendingPath,
    total: bookmarks.length,
    enriched: toEnrich.length,
    changed,
    mediaHydrated
  };
}

export function collectCodexImageInputs(pendingData, options = {}) {
  const maxImages = options.maxImages ?? 24;
  const imagePaths = [];

  for (const bookmark of pendingData.bookmarks || []) {
    for (const asset of bookmark.mediaAssets || []) {
      if (!asset.localPath || asset.kind === 'error') continue;
      if (!fs.existsSync(asset.localPath)) continue;
      imagePaths.push(asset.localPath);
      if (imagePaths.length >= maxImages) return imagePaths;
    }
  }

  return imagePaths;
}
