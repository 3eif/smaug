import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  formatBookmarkEntry,
  mergeArchive,
  validateArchiveOrder
} from '../src/bulk-archiver.js';

describe('formatBookmarkEntry', () => {
  test('formats a deterministic bookmark archive entry', () => {
    const entry = formatBookmarkEntry({
      id: '1',
      author: 'alice',
      text: 'Useful SwiftUI animation trick',
      tweetUrl: 'https://x.com/alice/status/1',
      date: 'Monday, January 1, 2024',
      links: [{ expanded: 'https://github.com/example/project', type: 'github' }],
      organization: {
        section: 'Coding Reference',
        signals: ['github.com', 'github']
      }
    });

    assert.match(entry, /^## @alice - Useful SwiftUI animation trick/m);
    assert.match(entry, /- \*\*Tweet:\*\* https:\/\/x\.com\/alice\/status\/1/);
    assert.match(entry, /- \*\*Link:\*\* https:\/\/github\.com\/example\/project/);
    assert.match(entry, /- \*\*Section:\*\* Coding Reference/);
  });
});

describe('mergeArchive', () => {
  test('sorts merged date sections descending and preserves existing bodies', () => {
    const archive = `# Monday, January 1, 2024\n\n## @old - Old\n\n- **Tweet:** https://x.com/old/status/1\n`;
    const entriesByDate = new Map([
      ['Tuesday, January 2, 2024', ['## @new - New\n\n- **Tweet:** https://x.com/new/status/2\n']],
      ['Monday, January 1, 2024', ['## @same - Same date\n\n- **Tweet:** https://x.com/same/status/3\n']]
    ]);

    const merged = mergeArchive(archive, entriesByDate);
    assert.ok(merged.indexOf('# Tuesday, January 2, 2024') < merged.indexOf('# Monday, January 1, 2024'));
    assert.ok(merged.indexOf('## @same - Same date') < merged.indexOf('## @old - Old'));
    assert.deepStrictEqual(validateArchiveOrder(merged), { ok: true, violations: [] });
  });

  test('detects ascending date order violations', () => {
    const archive = `# Monday, January 1, 2024\n\nBody\n\n---\n\n# Tuesday, January 2, 2024\n\nBody\n`;
    assert.strictEqual(validateArchiveOrder(archive).ok, false);
  });
});
