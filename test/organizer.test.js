import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyBookmark, collectCodexImageInputs, inferMediaRefs } from '../src/organizer.js';

describe('classifyBookmark', () => {
  test('classifies GitHub links as coding reference', () => {
    const result = classifyBookmark({
      id: '1',
      text: 'Useful SwiftUI animation repo',
      links: [{ type: 'github', expanded: 'https://github.com/example/project' }]
    });

    assert.strictEqual(result.category, 'coding_reference');
    assert.strictEqual(result.section, 'Coding Reference');
    assert.ok(result.signals.includes('github'));
  });

  test('classifies media-only bookmarks as visual reference', () => {
    const result = classifyBookmark({
      id: '2',
      text: '',
      links: [{ type: 'media', expanded: 'https://twitter.com/user/status/123/photo/1' }]
    });

    assert.strictEqual(result.category, 'visual_reference');
    assert.strictEqual(result.needsMediaAnalysis, true);
    assert.ok(result.signals.includes('has-media'));
  });

  test('classifies arxiv links as research papers', () => {
    const result = classifyBookmark({
      id: '3',
      text: 'new paper',
      links: [{ type: 'article', expanded: 'https://arxiv.org/abs/2604.07709' }]
    });

    assert.strictEqual(result.category, 'research_papers');
  });
});

describe('inferMediaRefs', () => {
  test('extracts media refs from media links and native media arrays', () => {
    const refs = inferMediaRefs({
      id: '4',
      links: [{ type: 'media', expanded: 'https://twitter.com/user/status/123/video/1' }],
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg', width: 100, height: 200 }]
    });

    assert.strictEqual(refs.length, 2);
    assert.ok(refs.some((ref) => ref.tweetId === '123' && ref.type === 'video'));
    assert.ok(refs.some((ref) => ref.type === 'photo' && ref.width === 100));
  });
});

describe('collectCodexImageInputs', () => {
  test('collects existing local media asset paths up to a cap', () => {
    const result = collectCodexImageInputs({
      bookmarks: [
        { mediaAssets: [
          { kind: 'image', localPath: new URL(import.meta.url).pathname },
          { kind: 'video-frame', localPath: new URL(import.meta.url).pathname }
        ] },
        { mediaAssets: [{ kind: 'image', localPath: '/definitely/missing.jpg' }] }
      ]
    }, { maxImages: 1 });

    assert.strictEqual(result.length, 1);
    assert.ok(result[0].endsWith('organizer.test.js'));
  });

  test('collects sampled video frames as Codex image inputs', () => {
    const result = collectCodexImageInputs({
      bookmarks: [
        { mediaAssets: [{ kind: 'video-frame', localPath: new URL(import.meta.url).pathname }] }
      ]
    }, { maxImages: 2 });

    assert.strictEqual(result.length, 1);
    assert.ok(result[0].endsWith('organizer.test.js'));
  });
});
