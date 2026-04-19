/* ════════════════════════════════════════════════
   ShopScanner — app.js
   Frontend logic: form, SSE, results, CSV, PDF
════════════════════════════════════════════════ */

// Production: window.SHOPSCANNER_API is set by config.js (injected at deploy time)
// Development: falls back to localhost
const API_BASE = window.SHOPSCANNER_API || 'http://localhost:3001';

let locationMode = 'auto';
let selectedCategory = 'kafe';
let currentJobId = null;
let sseSource = null;
let allResults = [];

// ── Location Mode ────────────────────────────────
function setLocationMode(mode) {
  locationMode = mode;
  document.getElementById('btnAutoLoc').classList.toggle('active', mode === 'auto');
  document.getElementById('btnManualLoc').classList.toggle('active', mode === 'manual');
  document.getElementById('autoLocStatus').classList.toggle('hidden', mode !== 'auto');
  document.getElementById('manualLocGroup').classList.toggle('hidden', mode !== 'manual');
}

// ── Category Select ──────────────────────────────
function selectCategory(btn, cat) {
  document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  selectedCategory = cat;
}

// ── Get Location ─────────────────────────────────
async function getLocation() {
  if (locationMode === 'manual') {
    const addr = document.getElementById('manualAddress').value.trim();
    if (!addr) throw new Error('Lütfen bir adres girin.');
    return addr;
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Tarayıcınız konum özelliğini desteklemiyor.'));
      return;
    }
    setStatusDot('waiting');
    document.getElementById('statusText').textContent = 'Konum alınıyor...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = `${pos.coords.latitude},${pos.coords.longitude}`;
        setStatusDot('ok');
        document.getElementById('statusText').textContent =
          `Konum alındı: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
        resolve(coords);
      },
      (err) => {
        setStatusDot('err');
        document.getElementById('statusText').textContent = 'Konum alınamadı: ' + err.message;
        reject(new Error('Konum izni reddedildi. Manuel adres giriniz.'));
      },
      { timeout: 10000 }
    );
  });
}

function setStatusDot(state) {
  const dot = document.getElementById('statusDot');
  dot.classList.remove('ok', 'err');
  if (state === 'ok') dot.classList.add('ok');
  if (state === 'err') dot.classList.add('err');
}

// ── Start Scan ───────────────────────────────────
async function startScan() {
  let location;
  try {
    location = await getLocation();
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  // UI switch to progress
  document.getElementById('formSection').classList.add('hidden');
  document.getElementById('progressSection').classList.remove('hidden');
  document.getElementById('resultsSection').classList.add('hidden');

  resetProgress();

  try {
    const res = await fetch(`${API_BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, category: selectedCategory }),
    });

    if (!res.ok) throw new Error('Sunucu hatası: ' + res.status);
    const { jobId } = await res.json();
    currentJobId = jobId;
    listenProgress(jobId);
  } catch (err) {
    showToast('Bağlantı hatası: ' + err.message, 'error');
    resetApp();
  }
}

// ── SSE Progress ─────────────────────────────────
function listenProgress(jobId) {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(`${API_BASE}/api/status/${jobId}`);

  sseSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    updateProgress(data);

    if (data.status === 'done') {
      sseSource.close();
      allResults = data.results || [];
      showResults(allResults);
    }

    if (data.status === 'error') {
      sseSource.close();
      showToast('Tarama hatası: ' + data.error, 'error');
      resetApp();
    }
  };

  sseSource.onerror = () => {
    sseSource.close();
    showToast('Bağlantı kesildi.', 'error');
  };
}

function updateProgress(data) {
  document.getElementById('progressMessage').textContent = data.message || '...';
  document.getElementById('statScanned').textContent = data.scanned || 0;
  document.getElementById('statFound').textContent = data.found || 0;

  // Estimate progress %
  const pct = data.scanned > 0 ? Math.min(95, (data.scanned / (data.scanned + 5)) * 100) : 5;
  document.getElementById('progressBar').style.width = (data.status === 'done' ? 100 : pct) + '%';

  if (data.status === 'done') {
    document.getElementById('progressSpinner').style.display = 'none';
    document.getElementById('progressMessage').textContent = '✅ ' + data.message;
  }

  // Live Results rendering
  const list = document.getElementById('liveResultsList');
  if (data.results && data.results.length > 0 && data.status !== 'done') {
    list.innerHTML = '';
    data.results.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<span style="color:var(--accent-2)">🟢</span> <strong>${escHtml(r.name)}</strong> <span style="font-size:0.8rem; color:var(--text-3)">— ${escHtml(r.category)}</span>`;
      list.appendChild(li);
    });
    // Scroll to bottom
    const area = document.getElementById('liveResultsArea');
    area.scrollTop = area.scrollHeight;
  }
}

function resetProgress() {
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('statScanned').textContent = '0';
  document.getElementById('statFound').textContent = '0';
  document.getElementById('progressMessage').textContent = 'Başlatılıyor...';
  document.getElementById('progressSub').textContent = 'Lütfen bekleyin';
  document.getElementById('progressSpinner').style.display = '';
  document.getElementById('liveResultsList').innerHTML = '<li class="live-results-empty">Tarama bekleniyor...</li>';
}

// ── Cancel ───────────────────────────────────────
function cancelScan() {
  if (sseSource) sseSource.close();
  resetApp();
}

// ── Show Results ─────────────────────────────────
function showResults(results) {
  document.getElementById('progressSection').classList.add('hidden');
  document.getElementById('resultsSection').classList.remove('hidden');

  const catLabels = { kafe: 'Kafe', restoran: 'Restoran', otel: 'Otel / Apart' };

  document.getElementById('resultsSub').textContent =
    `"${catLabels[selectedCategory] || selectedCategory}" araması — ${results.length} web sitesiz işyeri bulundu`;

  renderCards(results);
  updateFilterCount(results.length, results.length);

  if (results.length === 0) {
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('resultsGrid').classList.add('hidden');
  } else {
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('resultsGrid').classList.remove('hidden');
  }
}

function renderCards(data) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';

  data.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.style.animationDelay = `${Math.min(i * 0.05, 0.5)}s`;

    // Open/Closed badge
    let statusBadge = '';
    if (r.openNow === true) {
      statusBadge = '<span class="badge badge-open">🟢 Açık</span>';
    } else if (r.openNow === false) {
      statusBadge = '<span class="badge badge-closed">🔴 Kapalı</span>';
    }

    // Price level badge
    let priceBadge = '';
    if (r.priceLevel) {
      priceBadge = `<span class="badge badge-price">${escHtml(r.priceLevel)}</span>`;
    }

    // Star rating visual
    let ratingHtml = '';
    if (r.rating) {
      const numRating = parseFloat(r.rating.replace(',', '.'));
      const fullStars = Math.floor(numRating);
      const halfStar = numRating - fullStars >= 0.3;
      let stars = '';
      for (let s = 0; s < fullStars; s++) stars += '★';
      if (halfStar) stars += '½';
      const reviewCountText = r.reviewCount ? ` (${r.reviewCount})` : '';
      ratingHtml = `<div class="card-rating-row">
        <span class="card-rating-stars">${stars}</span>
        <span class="card-rating-num">${escHtml(r.rating)}</span>
        <span class="card-rating-count">${reviewCountText}</span>
      </div>`;
    }

    // Photo
    let photoHtml = '';
    if (r.photoUrl) {
      photoHtml = `<div class="card-photo"><img src="${escHtml(r.photoUrl)}" alt="${escHtml(r.name)}" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>`;
    } else {
      // Placeholder with icon
      const catIcons = { 'Kafe': '☕', 'Restoran': '🍽️', 'Otel': '🏨', 'Apart': '🏨' };
      const icon = Object.entries(catIcons).find(([k]) => (r.category || '').includes(k))?.[1] || '🏪';
      photoHtml = `<div class="card-photo card-photo-placeholder"><span>${icon}</span></div>`;
    }

    // Working hours
    let hoursHtml = '';
    if (r.openHoursText) {
      hoursHtml = `<div class="card-row"><span class="card-row-icon">🕐</span><span>${escHtml(r.openHoursText)}</span></div>`;
    }

    // Accessibility
    let accessHtml = '';
    if (r.accessibility && r.accessibility.length > 0) {
      accessHtml = `<div class="card-row"><span class="card-row-icon">♿</span><span>${r.accessibility.map(a => escHtml(a)).join(', ')}</span></div>`;
    }

    // Coordinates
    let coordsHtml = '';
    if (r.lat && r.lng) {
      coordsHtml = `<div class="card-row card-coords"><span class="card-row-icon">📌</span><span>${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}</span></div>`;
    }

    // Place ID
    let placeIdHtml = '';
    if (r.placeId) {
      placeIdHtml = `<div class="card-row card-placeid"><span class="card-row-icon">🆔</span><span class="truncate">${escHtml(r.placeId)}</span></div>`;
    }

    card.innerHTML = `
      ${photoHtml}
      <div class="card-body">
        <div class="card-header-row">
          <span class="card-num">#${String(i + 1).padStart(2, '0')}</span>
          <div class="card-badges">
            ${statusBadge}
            ${priceBadge}
          </div>
        </div>
        <div class="card-name">${escHtml(r.name || '—')}</div>
        ${r.category ? `<div class="card-cat">🏷️ ${escHtml(r.category)}</div>` : ''}
        ${ratingHtml}
        <div class="card-info">
          ${r.address  ? `<div class="card-row"><span class="card-row-icon">📍</span><span>${escHtml(r.address)}</span></div>`  : ''}
          ${r.phone    ? `<div class="card-row"><span class="card-row-icon">📞</span><span>${escHtml(r.phone)}</span></div>`    : ''}
          ${hoursHtml}
          ${accessHtml}
          ${coordsHtml}
          ${placeIdHtml}
        </div>
        <div class="card-actions">
          ${r.mapsUrl ? `<a class="card-btn primary" href="${escHtml(r.mapsUrl)}" target="_blank" rel="noreferrer">🗺️ Haritada Gör</a>` : ''}
          ${r.phone   ? `<button class="card-btn" onclick="copyText('${escAttr(r.phone)}')">📋 Kopyala</button>`                         : ''}
        </div>
      </div>
    `;

    grid.appendChild(card);
  });
}

// ── Filter ───────────────────────────────────────
function filterResults() {
  const q = document.getElementById('filterInput').value.toLowerCase();
  const filtered = allResults.filter(
    (r) =>
      (r.name    || '').toLowerCase().includes(q) ||
      (r.address || '').toLowerCase().includes(q) ||
      (r.phone   || '').toLowerCase().includes(q) ||
      (r.category || '').toLowerCase().includes(q)
  );
  renderCards(filtered);
  updateFilterCount(filtered.length, allResults.length);
}

function updateFilterCount(shown, total) {
  document.getElementById('filterCount').textContent =
    shown === total ? `${total} sonuç` : `${shown} / ${total} gösteriliyor`;
}

// ── CSV Export ───────────────────────────────────
function exportCSV() {
  if (!currentJobId) return;
  const url = `${API_BASE}/api/results/${currentJobId}/csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.click();
  showToast('CSV dosyası indiriliyor...', 'success');
}

// ── PDF Export ───────────────────────────────────
function exportPDF() {
  if (!currentJobId) return;
  const url = `${API_BASE}/api/results/${currentJobId}/pdf`;
  window.open(url, '_blank');
  showToast('PDF açılıyor...', 'success');
}

// ── Reset ────────────────────────────────────────
function resetApp() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  currentJobId = null;
  allResults = [];
  document.getElementById('filterInput').value = '';
  document.getElementById('formSection').classList.remove('hidden');
  document.getElementById('progressSection').classList.add('hidden');
  document.getElementById('resultsSection').classList.add('hidden');
}

// ── Helpers ──────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(s) {
  return String(s).replace(/'/g, "\\'");
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Kopyalandı!', 'success'));
}

function showToast(msg, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
