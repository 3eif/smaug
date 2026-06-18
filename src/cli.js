#!/usr/bin/env node

/**
 * Smaug CLI
 *
 * Commands:
 *   setup    - Interactive setup wizard (recommended for first-time users)
 *   run      - Run the full job (fetch + process with Claude Code)
 *   fetch    - Fetch bookmarks and prepare them for processing
 *   enrich   - Add organization and media metadata to pending bookmarks
 *   process  - Process pending bookmarks with Claude Code
 *   status   - Show current configuration and status
 *   init     - Create a config file (non-interactive)
 */

import { fetchAndPrepareBookmarks } from './processor.js';
import { initConfig, loadConfig } from './config.js';
import { enrichPendingBookmarks } from './organizer.js';
import { bulkArchivePendingBookmarks } from './bulk-archiver.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';

const args = process.argv.slice(2);
const command = args[0];

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup() {
  console.log(`
🐉 Smaug Setup Wizard
━━━━━━━━━━━━━━━━━━━━━

This will set up Smaug to automatically archive your Twitter bookmarks.
`);

  // Step 1: Check for bird CLI with bookmarks support (v0.5.0+)
  console.log('Step 1: Checking for bird CLI...');
  try {
    const versionOutput = execSync('bird --version', { stdio: 'pipe', encoding: 'utf8' });
    const versionMatch = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);

    if (versionMatch) {
      const [, major, minor] = versionMatch.map(Number);
      if (major === 0 && minor < 5) {
        console.log(`  ✗ bird CLI v${versionMatch[0]} found, but v0.5.0+ required for bookmarks support

  Update it:
    npm install -g @steipete/bird@latest

  Or with Homebrew:
    brew upgrade steipete/tap/bird

  Then run this setup again.
`);
        process.exit(1);
      }
      console.log(`  ✓ bird CLI v${versionMatch[0]} found (bookmarks supported)\n`);
    } else {
      console.log('  ✓ bird CLI found\n');
    }
  } catch {
    console.log(`  ✗ bird CLI not found

  Install it:
    npm install -g @steipete/bird@latest

  Or with Homebrew:
    brew install steipete/tap/bird

  Then run this setup again.
`);
    process.exit(1);
  }

  // Step 2: Get Twitter credentials
  console.log(`Step 2: Twitter Authentication

  You need your Twitter cookies to fetch bookmarks.

  To get them:
  1. Open Twitter/X in your browser
  2. Press F12 to open Developer Tools
  3. Go to Application → Cookies → twitter.com
  4. Find 'auth_token' and 'ct0'
`);

  const authToken = await prompt('  Paste your auth_token: ');
  if (!authToken) {
    console.log('  ✗ auth_token is required');
    process.exit(1);
  }

  const ct0 = await prompt('  Paste your ct0: ');
  if (!ct0) {
    console.log('  ✗ ct0 is required');
    process.exit(1);
  }

  // Step 3: Test credentials
  console.log('\nStep 3: Testing credentials...');
  try {
    const env = { ...process.env, AUTH_TOKEN: authToken, CT0: ct0 };
    execSync('bird bookmarks -n 1 --json', { env, stdio: 'pipe', timeout: 30000 });
    console.log('  ✓ Credentials work!\n');
  } catch (error) {
    console.log(`  ✗ Could not fetch bookmarks. Check your credentials and try again.
  Error: ${error.message}
`);
    process.exit(1);
  }

  // Step 4: Create config
  console.log('Step 4: Creating configuration...');
  const config = {
    archiveFile: './bookmarks.md',
    pendingFile: './.state/pending-bookmarks.json',
    stateFile: './.state/bookmarks-state.json',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    twitter: {
      authToken,
      ct0
    },
    autoInvokeClaude: true,
    claudeModel: 'sonnet'
  };

  fs.writeFileSync('./smaug.config.json', JSON.stringify(config, null, 2) + '\n');
  console.log('  ✓ Created smaug.config.json');
  console.log('  ⚠️  This file contains your credentials and is gitignored.');
  console.log('     Never commit it or share it publicly.\n');

  // Step 5: Ask about automation
  console.log('Step 5: Automation Setup\n');
  const wantsCron = await prompt('  Set up automatic fetching every 30 minutes? (y/n): ');

  if (wantsCron.toLowerCase() === 'y') {
    const cwd = process.cwd();
    const cronLine = `*/30 * * * * cd ${cwd} && npx smaug run >> ${cwd}/smaug.log 2>&1`;

    console.log(`
  Add this line to your crontab:

  ${cronLine}

  To edit your crontab, run:
    crontab -e

  Or use PM2 for a simpler setup:
    npm install -g pm2
    pm2 start "npx smaug run" --cron "*/30 * * * *" --name smaug
    pm2 save
`);
  }

  // Step 6: First fetch
  console.log('\nStep 6: Fetching your bookmarks...\n');

  try {
    const result = await fetchAndPrepareBookmarks({ count: 20 });

    if (result.count > 0) {
      console.log(`  ✓ Fetched ${result.count} bookmarks!\n`);
    } else {
      console.log('  ✓ No new bookmarks to fetch (your bookmark list may be empty)\n');
    }
  } catch (error) {
    console.log(`  Warning: Could not fetch bookmarks: ${error.message}\n`);
  }

  // Done!
  console.log(`
━━━━━━━━━━━━━━━━━━━━━
🐉 Setup Complete!
━━━━━━━━━━━━━━━━━━━━━

Your bookmarks will be saved to: ./bookmarks.md

Commands:
  npx smaug run    Run full job (fetch + process with Claude)
  npx smaug fetch  Fetch new bookmarks
  npx smaug status Check status

Happy hoarding! 🐉
`);
}

async function main() {
  switch (command) {
    case 'setup':
      await setup();
      break;

    case 'init':
      initConfig(args[1]);
      break;

    case 'run': {
      // Run the full job (same as node src/job.js)
      const jobPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job.js');
      const trackTokens = args.includes('--track-tokens') || args.includes('-t');

      // Parse --limit flag
      const limitIdx = args.findIndex(a => a === '--limit' || a === '-l');
      let limit = null;
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
        if (isNaN(limit) || limit <= 0) {
          console.error('Invalid --limit value. Must be a positive number.');
          process.exit(1);
        }
      }

      try {
        const jobModule = await import(pathToFileURL(jobPath).href);
        const result = await jobModule.default.run({ trackTokens, limit });
        process.exit(result.success ? 0 : 1);
      } catch (err) {
        console.error('Failed to run job:', err.message);
        process.exit(1);
      }
      break;
    }

    case 'fetch': {
      const count = parseInt(args.find(a => a.match(/^\d+$/)) || '20', 10);
      const specificIds = args.filter(a => a.match(/^\d{10,}$/));
      const force = args.includes('--force') || args.includes('-f');
      const includeMedia = args.includes('--media') || args.includes('-m');
      const fetchAll = args.includes('--all') || args.includes('-a') || args.includes('-all');

      // Parse --source flag
      const sourceIdx = args.findIndex(a => a === '--source' || a === '-s');
      let source = null;
      if (sourceIdx !== -1 && args[sourceIdx + 1]) {
        source = args[sourceIdx + 1];
        if (!['bookmarks', 'likes', 'both'].includes(source)) {
          console.error(`Invalid source: ${source}. Must be 'bookmarks', 'likes', or 'both'.`);
          process.exit(1);
        }
      }

      // Parse --max-pages flag
      const maxPagesIdx = args.findIndex(a => a === '--max-pages');
      let maxPages = null;
      if (maxPagesIdx !== -1 && args[maxPagesIdx + 1]) {
        maxPages = parseInt(args[maxPagesIdx + 1], 10);
      }

      // Parse --page-delay-ms flag
      const pageDelayIdx = args.findIndex(a => a === '--page-delay-ms');
      let pageDelayMs = null;
      if (pageDelayIdx !== -1 && args[pageDelayIdx + 1]) {
        pageDelayMs = parseInt(args[pageDelayIdx + 1], 10);
        if (Number.isNaN(pageDelayMs) || pageDelayMs < 0) {
          console.error('Invalid --page-delay-ms value. Must be 0 or greater.');
          process.exit(1);
        }
      }

      // Parse --page-size flag
      const pageSizeIdx = args.findIndex(a => a === '--page-size');
      let pageSize = null;
      if (pageSizeIdx !== -1 && args[pageSizeIdx + 1]) {
        pageSize = parseInt(args[pageSizeIdx + 1], 10);
        if (Number.isNaN(pageSize) || pageSize <= 0) {
          console.error('Invalid --page-size value. Must be a positive number.');
          process.exit(1);
        }
      }

      // Parse --bird-delay-ms flag
      const birdDelayIdx = args.findIndex(a => a === '--bird-delay-ms');
      let birdRequestDelayMs = null;
      if (birdDelayIdx !== -1 && args[birdDelayIdx + 1]) {
        birdRequestDelayMs = parseInt(args[birdDelayIdx + 1], 10);
        if (Number.isNaN(birdRequestDelayMs) || birdRequestDelayMs < 0) {
          console.error('Invalid --bird-delay-ms value. Must be 0 or greater.');
          process.exit(1);
        }
      }

      // Parse --bookmark-delay-ms flag
      const bookmarkDelayIdx = args.findIndex(a => a === '--bookmark-delay-ms');
      let bookmarkDelayMs = null;
      if (bookmarkDelayIdx !== -1 && args[bookmarkDelayIdx + 1]) {
        bookmarkDelayMs = parseInt(args[bookmarkDelayIdx + 1], 10);
        if (Number.isNaN(bookmarkDelayMs) || bookmarkDelayMs < 0) {
          console.error('Invalid --bookmark-delay-ms value. Must be 0 or greater.');
          process.exit(1);
        }
      }

      const result = await fetchAndPrepareBookmarks({
        count,
        specificIds: specificIds.length > 0 ? specificIds : null,
        force,
        source,
        includeMedia,
        all: fetchAll,
        maxPages,
        pageDelayMs,
        pageSize,
        birdRequestDelayMs,
        bookmarkDelayMs
      });

      if (result.count > 0) {
        console.log(`\n✓ Prepared ${result.count} tweets.`);
        console.log(`  Output: ${result.pendingFile}`);
        console.log('\nNext: Run `npx smaug run` to process with Claude');
      } else {
        console.log('\nNo new tweets to process.');
      }
      break;
    }

    case 'enrich': {
      const limitIdx = args.findIndex(a => a === '--limit' || a === '-l');
      let limit = null;
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
        if (Number.isNaN(limit) || limit <= 0) {
          console.error('Invalid --limit value. Must be a positive number.');
          process.exit(1);
        }
      }

      const birdDelayIdx = args.findIndex(a => a === '--bird-delay-ms');
      let birdDelayMs = 0;
      if (birdDelayIdx !== -1 && args[birdDelayIdx + 1]) {
        birdDelayMs = parseInt(args[birdDelayIdx + 1], 10);
        if (Number.isNaN(birdDelayMs) || birdDelayMs < 0) {
          console.error('Invalid --bird-delay-ms value. Must be 0 or greater.');
          process.exit(1);
        }
      }

      const videoFramesIdx = args.findIndex(a => a === '--video-frames');
      let videoFrameCount = null;
      if (videoFramesIdx !== -1) {
        videoFrameCount = args[videoFramesIdx + 1] ? parseInt(args[videoFramesIdx + 1], 10) : 3;
        if (Number.isNaN(videoFrameCount) || videoFrameCount < 0) {
          console.error('Invalid --video-frames value. Must be 0 or greater.');
          process.exit(1);
        }
      }

      const result = await enrichPendingBookmarks({
        limit,
        latest: args.includes('--latest'),
        force: args.includes('--force') || args.includes('-f'),
        fetchMedia: args.includes('--media') || args.includes('--fetch-media'),
        downloadMedia: args.includes('--download-media'),
        videoFrameCount,
        birdDelayMs
      });

      console.log(`Enriched ${result.enriched} / ${result.total} pending bookmarks.`);
      console.log(`Changed: ${result.changed}`);
      console.log(`With media refs: ${result.mediaHydrated}`);
      console.log(`Output: ${result.pendingFile}`);
      break;
    }

    case 'process': {
      const config = loadConfig();

      if (!fs.existsSync(config.pendingFile)) {
        console.log('No pending bookmarks. Run `smaug fetch` first.');
        process.exit(0);
      }

      const pending = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));

      if (pending.bookmarks.length === 0) {
        console.log('No pending bookmarks to process.');
        process.exit(0);
      }

      console.log(`Found ${pending.bookmarks.length} pending bookmarks.\n`);
      console.log('To process them:');
      console.log('  npx smaug run\n');

      console.log('Pending:');
      for (const b of pending.bookmarks.slice(0, 5)) {
        console.log(`  • @${b.author}: ${b.text.slice(0, 50)}...`);
      }
      if (pending.bookmarks.length > 5) {
        console.log(`  ... and ${pending.bookmarks.length - 5} more`);
      }
      break;
    }

    case 'bulk-archive': {
      const limitIdx = args.findIndex(a => a === '--limit' || a === '-l');
      let limit = null;
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
        if (Number.isNaN(limit) || limit <= 0) {
          console.error('Invalid --limit value. Must be a positive number.');
          process.exit(1);
        }
      }

      const result = await bulkArchivePendingBookmarks({
        limit,
        dryRun: args.includes('--dry-run')
      });

      console.log(`${result.dryRun ? 'Dry run' : 'Bulk archived'} ${result.selected} bookmark(s).`);
      console.log(`Date sections touched: ${result.dateSections}`);
      console.log(`Remaining pending: ${result.remaining}`);
      console.log(`Archive: ${result.archiveFile}`);
      console.log(`Pending: ${result.pendingFile}`);
      break;
    }

    case 'status': {
      const config = loadConfig();

      console.log('Smaug Status\n');
      console.log(`Archive:     ${config.archiveFile}`);
      console.log(`Source:      ${config.source || 'bookmarks'}`);
      console.log(`Media:       ${config.includeMedia ? '✓ enabled (experimental)' : 'disabled (use --media to enable)'}`);
      console.log(`Twitter:     ${config.twitter?.authToken ? '✓ configured' : '✗ not configured'}`);
      console.log(`AI CLI:      ${config.cliTool || 'claude'}`);
      if (config.cliTool === 'opencode') {
        console.log(`Auto-AI:     ${config.autoInvokeOpencode ? 'enabled' : 'disabled'}`);
      } else if (config.cliTool === 'codex') {
        console.log(`Auto-AI:     ${config.autoInvokeCodex ? 'enabled' : 'disabled'}`);
      } else {
        console.log(`Auto-AI:     ${config.autoInvokeClaude ? 'enabled' : 'disabled'}`);
      }

      if (fs.existsSync(config.pendingFile)) {
        const pending = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        console.log(`Pending:     ${pending.bookmarks.length} bookmarks`);
      } else {
        console.log('Pending:     0 bookmarks');
      }

      if (fs.existsSync(config.stateFile)) {
        const state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        console.log(`Last fetch:  ${state.last_check || 'never'}`);
      }

      if (fs.existsSync(config.archiveFile)) {
        const content = fs.readFileSync(config.archiveFile, 'utf8');
        const entryCount = (content.match(/^## @/gm) || []).length;
        console.log(`Archived:    ${entryCount} bookmarks`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
🐉 Smaug - Twitter Bookmarks & Likes Archiver

Commands:
  setup          Interactive setup wizard (start here!)
  run            Run the full job (fetch + process with Claude)
  run -t         Run with token usage tracking (--track-tokens)
  run --limit N  Process only N bookmarks (for large backlogs)
  fetch [n]      Fetch n tweets (default: 20)
  fetch --all    Fetch ALL bookmarks (paginated)
  fetch --max-pages N  Limit pagination to N pages (default: 10)
  fetch --page-delay-ms N  Sleep N milliseconds between bookmark pages
  fetch --page-size N  Fetch N bookmarks per page when delaying pagination
  fetch --bird-delay-ms N  Sleep N milliseconds before bird read/search calls
  fetch --bookmark-delay-ms N  Sleep N milliseconds between bookmark prep steps
  fetch --force  Re-fetch even if already archived
  fetch --source <source>  Fetch from: bookmarks, likes, or both
  fetch --media  EXPERIMENTAL: Include media attachments
  enrich         Add organization metadata to pending bookmarks
  enrich --media --download-media  Fetch media URLs and cache images/thumbnails
  enrich --media --download-media --video-frames 3  Sample frames from videos
  enrich --latest --limit N         Enrich newest N pending bookmarks
  bulk-archive   Fast deterministic archive of pending bookmarks without AI
  bulk-archive --dry-run --limit N  Validate fast archive output without writing
  process        Show pending tweets
  status         Show current status

Examples:
  smaug setup                    # First-time setup
  smaug run                      # Run full automation
  smaug run --limit 50           # Process 50 bookmarks at a time
  smaug fetch                    # Fetch latest (uses config source)
  smaug fetch 50                 # Fetch 50 tweets
  smaug fetch --all              # Fetch ALL bookmarks (paginated)
  smaug fetch --all --max-pages 5  # Fetch up to 5 pages
  smaug fetch 4000 --all --page-delay-ms 2000 --page-size 20
  smaug fetch 100 --all --bird-delay-ms 2000 --bookmark-delay-ms 500
  smaug fetch --source likes     # Fetch from likes only
  smaug fetch --source both      # Fetch from bookmarks AND likes
  smaug fetch --media            # Include photos/videos/GIFs (experimental)
  smaug fetch --force            # Re-process archived tweets
  smaug enrich                   # Classify pending bookmarks into richer sections
  smaug enrich --limit 25 --media --download-media
  smaug enrich --limit 25 --media --download-media --video-frames 3
  smaug enrich --latest --limit 25 --media --download-media
  smaug bulk-archive --dry-run    # Preview fast deterministic processing
  smaug bulk-archive              # Archive all pending bookmarks quickly

Config (smaug.config.json):
  "source": "bookmarks"    Default source (bookmarks, likes, or both)
  "includeMedia": false    EXPERIMENTAL: Include media (default: off)
  "folders": {}            Map folder IDs to tags (see README)

More info: https://github.com/alexknowshtml/smaug
`);
      break;
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
