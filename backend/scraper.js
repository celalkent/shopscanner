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
 * @param {function} onProgress - (scanned, found, message, partialResults) => void
 * @returns {Promise<Array>} - web sitesi olmayan yerlerin listesi
 */
async function scrapeGoogleMaps(location, category, onProgress) {
  const searchTerm = `${CATEGORY_MAP[category] || category} ${location}`;
  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    locale: 'tr-TR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const results = [];

  try {
    onProgress(0, 0, 'Google Maps açılıyor...', []);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Cookie/consent popup kabul et
    try {
      const acceptBtn = page.locator('button:has-text("Tümünü kabul et"), button:has-text("Accept all"), button[aria-label*="Accept"]');
      if (await acceptBtn.first().isVisible({ timeout: 3000 })) {
        await acceptBtn.first().click();
        await sleep(1000);
      }
    } catch {}

    onProgress(0, 0, 'Sonuçlar yükleniyor, liste kaydırılıyor...', []);

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
      onProgress(0, 0, `${currentCount} yer yüklendi, devam ediyor...`, []);
    }

    // Tüm yer kartlarını topla
    const placeCards = await page.locator('[role="feed"] > div > div[jsaction]').all();
    const total = Math.min(placeCards.length, MAX_RESULTS);
    onProgress(0, 0, `Toplam ${total} yer bulundu. Detaylar kontrol ediliyor...`, []);

    for (let i = 0; i < total; i++) {
      try {
        // Re-locate the card dynamically to avoid detached element errors
        const card = page.locator('[role="feed"] > div > div[jsaction]').nth(i);
        await card.scrollIntoViewIfNeeded({ timeout: 5000 });
        await card.click({ timeout: 5000 });
        await sleep(DELAY_MS);

        // Detay paneli yüklensin
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
        await sleep(1500); // Wait for details panel to fully populate

        const detail = await page.evaluate(() => {
          let name = document.querySelector('h1')?.innerText?.trim() || '';
          if (name === 'Sonuçlar' || name === 'Results') {
            name = document.title.split('-')[0].trim() || 'Bilinmiyor';
          }

          // Web sitesi kontrolü — geliştirilmiş belirleyiciler
          let hasWebsite = false;
          let website = null;
          
          const websiteElements = document.querySelectorAll('a, button, div[data-item-id]');
          for (const el of websiteElements) {
            const href = el.href || '';
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const text = (el.innerText || '').toLowerCase();
            const dataItemId = el.getAttribute('data-item-id') || '';
            const tooltip = (el.getAttribute('data-tooltip') || '').toLowerCase();
            
            // Eğer doğrudan authority (resmi web sitesi) ise
            if (dataItemId === 'authority' || ariaLabel.includes('web sitesi:') || ariaLabel.includes('website:')) {
              hasWebsite = true;
              website = href || text || 'Var';
              break;
            }
            
            // Link google haritalar/arama dışı otantik bir linkse ve metin/tooltip/aria'da "site" geçiyorsa
            if (el.tagName === 'A' && href.startsWith('http') && !href.includes('google.com/maps') && !href.includes('google.com/search')) {
              if (
                ariaLabel.includes('web sitesi') || 
                ariaLabel.includes('internet sitesi') || 
                ariaLabel.includes('website') ||
                ariaLabel.includes('siteyi aç') ||
                tooltip.includes('site') ||
                text.includes('web sitesi') ||
                text.includes('internet sitesi') ||
                text.includes('.com') || text.includes('.net') || text.includes('.org') || text.includes('.tr') ||
                href.includes('instagram.com') || href.includes('facebook.com') || href.includes('wa.me')
              ) {
                hasWebsite = true;
                website = href;
                break;
              }
            }
          }

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

          // ── YENİ: Fotoğraf URL'si ──
          // Detay panelindeki ana fotoğraf
          const photoEl = document.querySelector(
            'button[jsaction*="heroHeaderImage"] img, ' +
            'div[role="img"][style*="background-image"], ' +
            'img.p6VdBd, ' +
            'img[decoding="async"][src*="googleusercontent"]'
          );
          let photoUrl = '';
          if (photoEl) {
            if (photoEl.tagName === 'IMG') {
              photoUrl = photoEl.src || '';
            } else {
              const bgStyle = photoEl.style?.backgroundImage || '';
              const match = bgStyle.match(/url\(["']?(.*?)["']?\)/);
              if (match) photoUrl = match[1];
            }
          }

          // ── YENİ: Yorum Sayısı ──
          const reviewCountEl = document.querySelector(
            'button[jsaction*="reviewChart"] span, ' +
            'span[aria-label*="yorum"], ' +
            'button[aria-label*="yorum"]'
          );
          let reviewCount = '';
          if (reviewCountEl) {
            const txt = reviewCountEl.getAttribute('aria-label') || reviewCountEl.innerText || '';
            const match = txt.match(/([\d.,]+)/);
            if (match) reviewCount = match[1].replace(/\./g, '');
          }

          // ── YENİ: Fiyat Seviyesi ──
          // Google Maps fiyat seviyesini genellikle aria-label veya metin olarak gösterir
          let priceLevel = '';
          const priceLevelEl = document.querySelector(
            'span[aria-label*="Fiyat"], span[aria-label*="Price"], ' +
            'span:has(> span[aria-label*="₺"])'
          );
          if (priceLevelEl) {
            priceLevel = priceLevelEl.getAttribute('aria-label') || priceLevelEl.innerText || '';
          }
          // Alternatif: metin içinde ₺ ara
          if (!priceLevel) {
            const allSpans = document.querySelectorAll('span');
            for (const sp of allSpans) {
              const t = sp.innerText?.trim();
              if (t && /^[₺$€£]{1,4}$/.test(t)) {
                priceLevel = t;
                break;
              }
            }
          }

          // ── YENİ: Çalışma Saatleri + Açık/Kapalı Durumu ──
          let openNow = null; // true = açık, false = kapalı, null = bilinmiyor
          let openHoursText = '';

          // Açık/Kapalı durumu
          const openClosedEl = document.querySelector(
            'span[data-hide-tooltip-on-mouse-move], ' +
            'span.ZDu9vd, ' +
            '[data-item-id="oh"] .OqCZI span'
          );
          if (openClosedEl) {
            const ocText = openClosedEl.innerText?.trim().toLowerCase() || '';
            if (ocText.includes('açık') || ocText.includes('open')) {
              openNow = true;
            } else if (ocText.includes('kapalı') || ocText.includes('closed')) {
              openNow = false;
            }
            openHoursText = openClosedEl.innerText?.trim() || '';
          }

          // Tam çalışma saatleri tablosu
          let workingHours = [];
          const hourRows = document.querySelectorAll('table.eK4R0e tr, table.WgFkxc tr, div[aria-label*="saat"] table tr');
          if (hourRows.length > 0) {
            hourRows.forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 2) {
                workingHours.push({
                  day: cells[0].innerText?.trim() || '',
                  hours: cells[1].innerText?.trim() || ''
                });
              }
            });
          }
          // Günlük çalışma saati (kısa versiyon)
          if (!openHoursText) {
            const hoursBtn = document.querySelector(
              'button[data-item-id="oh"], [aria-label*="saat"]'
            );
            if (hoursBtn) {
              openHoursText = hoursBtn.innerText?.trim() || '';
            }
          }

          // ── YENİ: Erişilebilirlik ──
          let accessibility = [];
          const accGroup = document.querySelector(
            'div[aria-label*="Erişilebilirlik"], div[aria-label*="Accessibility"]'
          );
          if (accGroup) {
            const accItems = accGroup.querySelectorAll('li, span');
            accItems.forEach(el => {
              const t = el.innerText?.trim();
              if (t && t.length > 2 && t.length < 100) {
                accessibility.push(t);
              }
            });
          }
          // Alternatif: tekerlekli sandalye icon
          const wheelchairEl = document.querySelector(
            '[data-item-id*="wheelchair"], [aria-label*="tekerlekli"], [aria-label*="wheelchair"]'
          );
          if (wheelchairEl && accessibility.length === 0) {
            accessibility.push(wheelchairEl.getAttribute('aria-label') || 'Tekerlekli sandalye erişimi var');
          }

          // ── YENİ: Koordinatlar (URL'den parse) ──
          let lat = null;
          let lng = null;
          const currentUrl = window.location.href;
          // URL pattern: @41.0082,28.9784,15z
          const coordMatch = currentUrl.match(/@(-?[\d.]+),(-?[\d.]+)/);
          if (coordMatch) {
            lat = parseFloat(coordMatch[1]);
            lng = parseFloat(coordMatch[2]);
          }

          // ── YENİ: Place ID (URL'den parse) ──
          let placeId = '';
          const placeIdMatch = currentUrl.match(/place\/[^/]+\/([^/]+)/);
          if (placeIdMatch) {
            placeId = placeIdMatch[1];
          }
          // Alternatif: data-pid attribute'u
          if (!placeId) {
            const pidEl = document.querySelector('[data-pid]');
            if (pidEl) placeId = pidEl.getAttribute('data-pid') || '';
          }

          const mapsUrl = currentUrl;

          return { 
            name, hasWebsite, website, address, phone, rating, category, mapsUrl,
            // Yeni alanlar
            photoUrl, reviewCount, priceLevel, 
            openNow, openHoursText, workingHours,
            accessibility: accessibility.length > 0 ? accessibility : null,
            lat, lng, placeId
          };
        });

        if (detail.name && !detail.hasWebsite) {
          results.push(detail);
        }

        onProgress(i + 1, results.length, `${i + 1}/${total} tarandı — ${results.length} web sitesiz yer bulundu`, [...results]);

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
        onProgress(i + 1, results.length, `Hata (${i + 1}): ${err.message.slice(0, 60)}`, [...results]);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { scrapeGoogleMaps };
