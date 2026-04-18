const { chromium } = require('playwright');

const DELAY_MS = parseInt(process.env.DELAY_MS || '1500');
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS || '60');

const CATEGORY_MAP = {
  kafe: 'kafe',
  restoran: 'restoran',
  otel: 'otel apart',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ana scraper fonksiyonu.
 * @param {string} location  - "Kadıköy İstanbul" gibi adres ya da "41.0082,28.9784" coord
 * @param {string} category  - "kafe" | "restoran" | "otel"
 * @param {function} onProgress - (scanned, found, message) => void
 * @returns {Promise<Array>} - web sitesi olmayan yerlerin listesi
 */
async function scrapeGoogleMaps(location, category, onProgress) {
  const searchTerm = `${CATEGORY_MAP[category] || category} ${location}`;
  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'tr-TR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const results = [];

  try {
    onProgress(0, 0, 'Google Maps açılıyor...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    // Cookie/consent popup kabul et
    try {
      const acceptBtn = page.locator('button:has-text("Tümünü kabul et"), button:has-text("Accept all"), button[aria-label*="Accept"]');
      if (await acceptBtn.first().isVisible({ timeout: 3000 })) {
        await acceptBtn.first().click();
        await sleep(1000);
      }
    } catch {}

    onProgress(0, 0, 'Sonuçlar yükleniyor, liste kaydırılıyor...');

    // Sonuç panelini bul ve kaydır
    const resultPanel = page.locator('[role="feed"]');
    let prevCount = 0;
    let staleCount = 0;

    for (let i = 0; i < 15; i++) {
      const items = await page.locator('[role="feed"] > div > div[jsaction]').all();
      const currentCount = items.length;

      if (currentCount >= MAX_RESULTS) break;
      if (currentCount === prevCount) {
        staleCount++;
        if (staleCount >= 3) break;
      } else {
        staleCount = 0;
      }

      prevCount = currentCount;

      try {
        await resultPanel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      } catch {
        await page.mouse.wheel(0, 3000);
      }
      await sleep(1500);
      onProgress(0, 0, `${currentCount} yer yüklendi, devam ediyor...`);
    }

    // Tüm yer kartlarını topla
    const placeCards = await page.locator('[role="feed"] > div > div[jsaction]').all();
    const total = Math.min(placeCards.length, MAX_RESULTS);
    onProgress(0, 0, `Toplam ${total} yer bulundu. Detaylar kontrol ediliyor...`);

    for (let i = 0; i < total; i++) {
      try {
        const card = placeCards[i];
        await card.scrollIntoViewIfNeeded();
        await card.click();
        await sleep(DELAY_MS);

        // Detay paneli yüklensin
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});

        const detail = await page.evaluate(() => {
          const name = document.querySelector('h1')?.innerText?.trim() || '';

          // Web sitesi kontrolü — ikon + "Web sitesini ziyaret et" aria-label
          const websiteBtn = document.querySelector(
            'a[data-item-id="authority"], a[aria-label*="Web sitesi"], a[aria-label*="website"], a[href*="http"][data-tooltip*="ite"]'
          );
          const hasWebsite = !!websiteBtn;
          const website = websiteBtn?.href || null;

          // Adres
          const addressEl = document.querySelector('[data-item-id="address"], button[data-tooltip="Adresi kopyala"] div, [aria-label*="Adres"]');
          const address = addressEl?.innerText?.trim() || 
            document.querySelector('button[data-item-id^="address"]')?.innerText?.trim() || '';

          // Telefon
          const phoneEl = document.querySelector(
            '[data-item-id^="phone"], button[data-tooltip="Telefonu kopyala"] div, [aria-label*="Telefon"]'
          );
          const phone = phoneEl?.innerText?.trim() ||
            document.querySelector('button[data-item-id^="phone"]')?.innerText?.trim() || '';

          // Puan
          const rating = document.querySelector('div[role="img"][aria-label*="yıldız"], span[aria-label*="yıldız"]')
            ?.getAttribute('aria-label')?.match(/[\d,.]+/)?.[0] || '';

          // Kategori
          const category = document.querySelector('button[jsaction*="category"]')?.innerText?.trim() || 
            document.querySelector('span.DkEaL')?.innerText?.trim() || '';

          const mapsUrl = window.location.href;

          return { name, hasWebsite, website, address, phone, rating, category, mapsUrl };
        });

        if (detail.name && !detail.hasWebsite) {
          results.push(detail);
        }

        onProgress(i + 1, results.length, `${i + 1}/${total} tarandı — ${results.length} web sitesiz yer bulundu`);

        // Listeye geri dön
        const backBtn = page.locator('button[aria-label="Geri"], button[aria-label="Back"]');
        if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await backBtn.click();
          await sleep(800);
        } else {
          await page.goBack();
          await sleep(800);
        }
      } catch (err) {
        onProgress(i + 1, results.length, `Hata (${i + 1}): ${err.message.slice(0, 60)}`);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { scrapeGoogleMaps };
