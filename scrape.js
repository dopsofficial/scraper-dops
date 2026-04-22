const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  const targetUrl = 'https://www.tiktok.com/@tiktok';

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  // debug: lihat title dan URL final
  console.log('Page title:', await page.title());
  console.log('Final URL:', page.url());

  // tutup popup umum kalau ada
  const popupButtons = [
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("Not now")',
    'button:has-text("Close")',
    '[data-e2e="modal-close-inner-button"]',
  ];

  for (const selector of popupButtons) {
    const btn = page.locator(selector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  // scroll biar grid video kebaca
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(3000);

  // coba beberapa selector alternatif
  const selectors = [
    'a[href*="/video/"]',
    'div[data-e2e="user-post-item"] a',
    'div[data-e2e="user-post-item-list"] a',
    'main a[href*="/video/"]',
  ];

  let videoLinks = [];

  for (const selector of selectors) {
    const links = await page.locator(selector).evaluateAll((els) =>
      [...new Set(
        els
          .map((el) => el.href || el.getAttribute('href'))
          .filter(Boolean)
          .map((href) => href.startsWith('http') ? href : `https://www.tiktok.com${href}`)
      )]
    ).catch(() => []);

    console.log(`Selector ${selector} =>`, links.length);

    if (links.length > 0) {
      videoLinks = links;
      break;
    }
  }

  console.log('Video links found:', videoLinks);

  await browser.close();
})();