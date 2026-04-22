const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const XLSX = require('xlsx');

const INPUT_FILE = 'links.txt'; // atau links.csv
const OUTPUT_CSV_FILE = 'tiktok_results.csv';
const OUTPUT_XLSX_FILE = 'tiktok_results.xlsx';
const DEBUG_FILE = 'tiktok_debug.json';

function readTxtLinks(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readCsvLinks(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const firstValue = Object.values(row).find((v) => String(v).trim());
        if (firstValue) results.push(String(firstValue).trim());
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function getInputLinks(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return await readCsvLinks(filePath);
  return readTxtLinks(filePath);
}

async function closePopups(page) {
  const popupButtons = [
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("Not now")',
    'button:has-text("Close")',
    'button:has-text("Sekarang tidak")',
    '[data-e2e="modal-close-inner-button"]',
  ];

  for (const selector of popupButtons) {
    const btn = page.locator(selector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
}

function findObjectWithStats(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;

  if (
    obj.stats &&
    (obj.id || obj.desc !== undefined || obj.author || obj.video || obj.itemStruct)
  ) {
    return obj.itemStruct || obj;
  }

  for (const key of Object.keys(obj)) {
    const found = findObjectWithStats(obj[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function normalizeVideoData(item) {
  if (!item) return null;

  return {
    video_id: item.id ?? item.video?.id ?? null,
    author: item.author?.uniqueId ?? item.author?.nickname ?? item.author ?? null,
    caption: item.desc ?? null,
    views: item.stats?.playCount ?? item.stats?.play_count ?? item.stats?.plays ?? null,
    likes: item.stats?.diggCount ?? item.stats?.likeCount ?? item.stats?.likes ?? null,
    comments: item.stats?.commentCount ?? item.stats?.comments ?? null,
    shares: item.stats?.shareCount ?? item.stats?.shares ?? null,
  };
}

async function extractFromScriptTags(page) {
  const scripts = await page.locator('script').allTextContents();
  const debug = {
    script_count: scripts.length,
    matched_scripts: [],
  };

  for (let i = 0; i < scripts.length; i++) {
    const text = scripts[i];
    if (!text || text.length < 50) continue;

    const looksRelevant =
      text.includes('playCount') ||
      text.includes('diggCount') ||
      text.includes('commentCount') ||
      text.includes('shareCount') ||
      text.includes('itemStruct') ||
      text.includes('webapp.video-detail');

    if (!looksRelevant) continue;

    debug.matched_scripts.push({
      index: i,
      preview: text.slice(0, 300),
    });

    try {
      const parsed = JSON.parse(text);
      const found = findObjectWithStats(parsed);
      const normalized = normalizeVideoData(found);

      if (normalized && (normalized.video_id || normalized.views !== null)) {
        return {
          ok: true,
          source: `script_json_${i}`,
          data: normalized,
          debug,
        };
      }
    } catch (_) {
      // lanjut
    }

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const candidate = text.slice(jsonStart, jsonEnd + 1);

      try {
        const parsed = JSON.parse(candidate);
        const found = findObjectWithStats(parsed);
        const normalized = normalizeVideoData(found);

        if (normalized && (normalized.video_id || normalized.views !== null)) {
          return {
            ok: true,
            source: `script_embedded_json_${i}`,
            data: normalized,
            debug,
          };
        }
      } catch (_) {
        // lanjut
      }
    }
  }

  return {
    ok: false,
    source: null,
    data: null,
    debug,
  };
}

async function scrapeTikTokStats(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  await closePopups(page);
  await page.waitForTimeout(4000);

  const finalUrl = page.url();
  const title = await page.title().catch(() => null);

  const extracted = await extractFromScriptTags(page);

  return {
    input_url: url,
    final_url: finalUrl,
    page_title: title,
    video_id: extracted?.data?.video_id ?? null,
    author: extracted?.data?.author ?? null,
    caption: extracted?.data?.caption ?? null,
    views: extracted?.data?.views ?? null,
    likes: extracted?.data?.likes ?? null,
    comments: extracted?.data?.comments ?? null,
    shares: extracted?.data?.shares ?? null,
    source: extracted?.source ?? null,
    error: extracted?.ok ? null : 'Video data not found in script tags',
    debug: extracted?.debug ?? null,
  };
}

function saveResultsToXlsx(results, outputFile) {
  const worksheet = XLSX.utils.json_to_sheet(results);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, worksheet, 'TikTok Results');
  XLSX.writeFile(workbook, outputFile);
}

(async () => {
  const links = await getInputLinks(INPUT_FILE);
  console.log(`Total links: ${links.length}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 300,
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const results = [];
  const debugResults = [];

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    console.log(`[${i + 1}/${links.length}] Scraping: ${url}`);

    try {
      const result = await scrapeTikTokStats(page, url);

      results.push({
        input_url: result.input_url,
        final_url: result.final_url,
        page_title: result.page_title,
        video_id: result.video_id,
        author: result.author,
        caption: result.caption,
        views: result.views,
        likes: result.likes,
        comments: result.comments,
        shares: result.shares,
        source: result.source,
        error: result.error,
      });

      debugResults.push({
        input_url: result.input_url,
        final_url: result.final_url,
        source: result.source,
        debug: result.debug,
      });

      console.log(
        `OK | views=${result.views} likes=${result.likes} comments=${result.comments} source=${result.source}`
      );
    } catch (error) {
      results.push({
        input_url: url,
        final_url: null,
        page_title: null,
        video_id: null,
        author: null,
        caption: null,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        source: null,
        error: error.message,
      });

      debugResults.push({
        input_url: url,
        final_url: null,
        source: null,
        debug: { error: error.message },
      });

      console.log('ERROR:', error.message);
    }

    await page.waitForTimeout(2000);
  }

  const csvWriter = createCsvWriter({
    path: OUTPUT_CSV_FILE,
    header: [
      { id: 'input_url', title: 'input_url' },
      { id: 'final_url', title: 'final_url' },
      { id: 'page_title', title: 'page_title' },
      { id: 'video_id', title: 'video_id' },
      { id: 'author', title: 'author' },
      { id: 'caption', title: 'caption' },
      { id: 'views', title: 'views' },
      { id: 'likes', title: 'likes' },
      { id: 'comments', title: 'comments' },
      { id: 'shares', title: 'shares' },
      { id: 'source', title: 'source' },
      { id: 'error', title: 'error' },
    ],
  });

  await csvWriter.writeRecords(results);
  saveResultsToXlsx(results, OUTPUT_XLSX_FILE);
  fs.writeFileSync(DEBUG_FILE, JSON.stringify(debugResults, null, 2), 'utf-8');

  console.log(`Saved to ${OUTPUT_CSV_FILE}`);
  console.log(`Saved to ${OUTPUT_XLSX_FILE}`);
  console.log(`Saved debug to ${DEBUG_FILE}`);

  await browser.close();
})();