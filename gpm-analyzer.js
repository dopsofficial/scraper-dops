const { chromium } = require('playwright');
const XLSX = require('xlsx');
const fs = require('fs');
const readline = require('readline');

const SESSION_FILE = 'tiktok-session.json';
const PINNED_TO_SKIP = 3;
const VIDEO_TARGET_COUNT = 12;

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
      await page.waitForTimeout(300);
    }
  }
}

async function ensureVerifiedSession(browser) {
  let context;

  if (fs.existsSync(SESSION_FILE)) {
    context = await browser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    return context;
  }

  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  await page.goto('https://www.tiktok.com', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await closePopups(page);

  console.log('\nSelesaikan verifikasi / login TikTok secara manual di browser yang terbuka.');
  console.log('Jangan buru-buru. Tunggu sampai halaman TikTok sudah normal.');
  console.log('Setelah selesai verifikasi dan TikTok bisa dipakai, kembali ke terminal.\n');

  await ask('Kalau verifikasi sudah selesai, tekan Enter untuk lanjut...');

  await context.storageState({ path: SESSION_FILE });
  console.log(`Session berhasil disimpan ke ${SESSION_FILE}\n`);

  return context;
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

async function extractViewCountFromVideoPage(videoPage) {
  return await videoPage.evaluate(() => {
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

    const scripts = Array.from(document.querySelectorAll('script'))
      .map((s) => s.textContent || '')
      .filter(Boolean);

    for (const text of scripts) {
      const looksRelevant =
        text.includes('playCount') ||
        text.includes('itemStruct') ||
        text.includes('webapp.video-detail');

      if (!looksRelevant) continue;

      try {
        const parsed = JSON.parse(text);
        const found = findObjectWithStats(parsed);
        if (found?.stats?.playCount != null) {
          return Number(found.stats.playCount);
        }
      } catch (_) {}

      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
          const found = findObjectWithStats(parsed);
          if (found?.stats?.playCount != null) {
            return Number(found.stats.playCount);
          }
        } catch (_) {}
      }
    }

    return null;
  });
}

async function getVideoLinks(page, username) {
  await page.goto(`https://www.tiktok.com/@${username}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await page.waitForTimeout(2500);
  await closePopups(page);
  await page.waitForTimeout(1000);

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/verify')) {
    throw new Error('TikTok masih meminta verifikasi/login. Jalankan ulang setelah session valid.');
  }

  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(1200);

  const rawLinks = await page.locator('a[href*="/video/"]').evaluateAll((els) =>
    [...new Set(els.map((el) => el.href).filter(Boolean))]
  );

  if (!rawLinks.length) {
    throw new Error(`Tidak menemukan video di profil @${username}`);
  }

  return rawLinks.slice(PINNED_TO_SKIP, PINNED_TO_SKIP + VIDEO_TARGET_COUNT);
}

async function getVideoViews(page, context, username) {
  const links = await getVideoLinks(page, username);

  if (!links.length) {
    throw new Error(`Tidak ada video non-pinned yang berhasil diambil untuk @${username}`);
  }

  const views = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const videoPage = await context.newPage();

    try {
      console.log(`Ambil views video ${i + 1}/${links.length}`);
      await videoPage.goto(link, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await videoPage.waitForTimeout(2200);
      await closePopups(videoPage);
      await videoPage.waitForTimeout(500);

      const viewCount = await extractViewCountFromVideoPage(videoPage);

      if (viewCount !== null && !Number.isNaN(Number(viewCount))) {
        views.push(Number(viewCount));
      } else {
        console.log(`Views tidak terbaca untuk: ${link}`);
      }
    } catch (error) {
      console.log(`Gagal ambil views dari ${link}: ${error.message}`);
    } finally {
      await videoPage.close();
    }
  }

  return views;
}

function calculateGPM(views, ratecard) {
  const videoCount = views.length;
  const totalViews = views.reduce((a, b) => a + b, 0);
  const avgViews = videoCount > 0 ? totalViews / videoCount : 0;
  const gpm = avgViews > 0 ? ratecard / avgViews : 0;

  let decision = 'SKIP';
  if (gpm < 10) decision = 'AMBIL';
  else if (gpm < 20) decision = 'TEST';

  return {
    video_count: videoCount,
    total_views: totalViews,
    avg_views: Math.round(avgViews),
    gpm: Number(gpm.toFixed(2)),
    decision,
  };
}

function saveToExcel(username, ratecard, views, result) {
  const row = {
    username,
    ratecard,
    video_count: result.video_count,
    view_1: views[0] ?? null,
    view_2: views[1] ?? null,
    view_3: views[2] ?? null,
    view_4: views[3] ?? null,
    view_5: views[4] ?? null,
    view_6: views[5] ?? null,
    view_7: views[6] ?? null,
    view_8: views[7] ?? null,
    view_9: views[8] ?? null,
    view_10: views[9] ?? null,
    view_11: views[10] ?? null,
    view_12: views[11] ?? null,
    total_views: result.total_views,
    avg_views: result.avg_views,
    gpm: result.gpm,
    decision: result.decision,
  };

  const ws = XLSX.utils.json_to_sheet([row]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'GPM');

  const safeUsername = username.replace(/[^\w.-]/g, '_');
  const outputFile = `gpm_result_${safeUsername}.xlsx`;

  XLSX.writeFile(wb, outputFile);
  return outputFile;
}

async function run() {
  const usernameInput = await ask('Masukkan username TikTok: ');
  const ratecardInput = await ask('Masukkan ratecard: ');

  const username = usernameInput.replace(/^@/, '').trim();
  const ratecard = Number(String(ratecardInput).replace(/[^\d.]/g, ''));

  if (!username) {
    console.log('Username tidak boleh kosong.');
    process.exit(1);
  }

  if (!Number.isFinite(ratecard) || ratecard <= 0) {
    console.log('Ratecard harus berupa angka valid.');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
  });

  try {
    const context = await ensureVerifiedSession(browser);

    await context.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();

    console.log(`\nMengambil ${VIDEO_TARGET_COUNT} video non-pinned dari @${username}...\n`);
    const views = await getVideoViews(page, context, username);

    if (!views.length) {
      console.log('Tidak berhasil mengambil data views.');
      process.exit(1);
    }

    const result = calculateGPM(views, ratecard);

    console.log('\nViews ditemukan:');
    console.log(views);

    console.log('\nHasil analisa GPM:');
    console.log({
      username,
      ratecard,
      video_count: result.video_count,
      total_views: result.total_views,
      avg_views: result.avg_views,
      gpm: result.gpm,
      decision: result.decision,
    });

    const outputFile = saveToExcel(username, ratecard, views, result);
    console.log(`\nFile Excel berhasil dibuat: ${outputFile}`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error('\nTerjadi error:', error.message);
  process.exit(1);
});