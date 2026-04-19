require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const { scrapeGoogleMaps } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, cb) => {
    // Allow: no origin (curl/mobile), localhost, and any github.io domain
    if (!origin || origin.includes('localhost') || origin.includes('github.io')) {
      return cb(null, true);
    }
    cb(new Error('CORS: origin not allowed → ' + origin));
  },
  credentials: true,
}));
app.use(express.json());

// Statik frontend dosyalarını sun
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Aktif joblar: { jobId: { status, progress, results, error } }
const jobs = {};

// Eski jobları temizlemek için çöp toplayıcı (Her 1 saatte bir çalışır, 2 saatten eski jobları siler)
setInterval(() => {
  const now = Date.now();
  for (const jobId in jobs) {
    if (jobs[jobId].createdAt && (now - jobs[jobId].createdAt > 2 * 60 * 60 * 1000)) {
      delete jobs[jobId];
    }
  }
}, 60 * 60 * 1000);

// ─── POST /api/scan ─────────────────────────────────────────────────────────
// Yeni bir tarama başlatır, jobId döner
app.post('/api/scan', async (req, res) => {
  const { location, category } = req.body;

  if (!location || !category) {
    return res.status(400).json({ error: 'location ve category zorunludur.' });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    status: 'running',
    scanned: 0,
    found: 0,
    message: 'Başlatılıyor...',
    results: [],
    error: null,
    createdAt: Date.now(),
  };

  // Taramayı arka planda başlat
  (async () => {
    try {
      const results = await scrapeGoogleMaps(location, category, (scanned, found, message, partial) => {
        jobs[jobId].scanned = scanned;
        jobs[jobId].found = found;
        jobs[jobId].message = message;
        if(partial) jobs[jobId].results = partial;
      });

      jobs[jobId].results = results;
      jobs[jobId].status = 'done';
      jobs[jobId].message = `Tamamlandı! ${results.length} web sitesiz ${category} bulundu.`;
    } catch (err) {
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    }
  })();

  res.json({ jobId });
});

// ─── GET /api/status/:jobId ──────────────────────────────────────────────────
// Server-Sent Events ile canlı ilerleme
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) return res.status(404).json({ error: 'Job bulunamadı.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = () => {
    const j = jobs[jobId];
    const payload = JSON.stringify({
      status: j.status,
      scanned: j.scanned,
      found: j.found,
      message: j.message,
      results: j.results || [],
      error: j.error,
    });
    res.write(`data: ${payload}\n\n`);
  };

  send();
  const interval = setInterval(() => {
    const j = jobs[jobId];
    send();
    if (j.status === 'done' || j.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 800);

  req.on('close', () => clearInterval(interval));
});

// ─── GET /api/results/:jobId/csv ─────────────────────────────────────────────
app.get('/api/results/:jobId/csv', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Sonuç yok.' });

  const header = 'İşyeri Adı,Kategori,Adres,Telefon,Puan,Yorum Sayısı,Fiyat Seviyesi,Açık/Kapalı,Çalışma Saatleri,Erişilebilirlik,Enlem,Boylam,Place ID,Google Maps Linki\n';
  const rows = job.results
    .map((r) =>
      [
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.category || '').replace(/"/g, '""')}"`,
        `"${(r.address || '').replace(/"/g, '""')}"`,
        `"${(r.phone || '').replace(/"/g, '""')}"`,
        `"${r.rating || ''}"`,
        `"${r.reviewCount || ''}"`,
        `"${r.priceLevel || ''}"`,
        `"${r.openNow === true ? 'Açık' : r.openNow === false ? 'Kapalı' : 'Bilinmiyor'}"`,
        `"${(r.openHoursText || '').replace(/"/g, '""')}"`,
        `"${(r.accessibility || []).join('; ').replace(/"/g, '""')}"`,
        `"${r.lat || ''}"`,
        `"${r.lng || ''}"`,
        `"${r.placeId || ''}"`,
        `"${r.mapsUrl || ''}"`,
      ].join(',')
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="websitesiz_dukkanlar_${Date.now()}.csv"`);
  res.send('\uFEFF' + header + rows); // BOM for Excel UTF-8
});

// ─── GET /api/results/:jobId/pdf ─────────────────────────────────────────────
app.get('/api/results/:jobId/pdf', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Sonuç yok.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="websitesiz_dukkanlar_${Date.now()}.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);

  // Başlık
  doc.fontSize(22).font('Helvetica-Bold').text('Web Sitesiz Dukkanlar Raporu', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(11).font('Helvetica').text(`Olusturulma: ${new Date().toLocaleString('tr-TR')}`, { align: 'center' });
  doc.fontSize(11).text(`Toplam: ${job.results.length} isyeri`, { align: 'center' });
  doc.moveDown(1);

  // Ayırıcı çizgi
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  job.results.forEach((r, i) => {
    if (doc.y > 680) doc.addPage();

    doc.fontSize(13).font('Helvetica-Bold').text(`${i + 1}. ${r.name || '-'}`);
    doc.fontSize(10).font('Helvetica');

    if (r.category)   doc.text(`Kategori       : ${r.category}`);
    if (r.address)    doc.text(`Adres          : ${r.address}`);
    if (r.phone)      doc.text(`Telefon        : ${r.phone}`);
    if (r.rating)     doc.text(`Puan           : ${r.rating} yildiz`);
    if (r.reviewCount) doc.text(`Yorum Sayisi   : ${r.reviewCount}`);
    if (r.priceLevel) doc.text(`Fiyat Seviyesi : ${r.priceLevel}`);
    
    // Açık/Kapalı
    const openStatus = r.openNow === true ? 'Acik' : r.openNow === false ? 'Kapali' : 'Bilinmiyor';
    doc.text(`Durum          : ${openStatus}`);
    if (r.openHoursText) doc.text(`Calisma Saati  : ${r.openHoursText}`);
    
    // Erişilebilirlik
    if (r.accessibility && r.accessibility.length > 0) {
      doc.text(`Erisebilirlik  : ${r.accessibility.join(', ')}`);
    }
    
    // Koordinatlar
    if (r.lat && r.lng)  doc.text(`Koordinat      : ${r.lat}, ${r.lng}`);
    if (r.placeId)       doc.text(`Place ID       : ${r.placeId}`);
    if (r.mapsUrl)       doc.text(`Harita         : ${r.mapsUrl}`, { link: r.mapsUrl, underline: true, ellipsis: true });

    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke('#cccccc');
    doc.moveDown(0.4);
  });

  doc.end();
});

// ─── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 ShopScanner çalışıyor → http://localhost:${PORT}\n`);
});
