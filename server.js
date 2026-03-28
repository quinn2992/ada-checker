const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { scanUrl, closeBrowser } = require('./src/scanner');
const { parseReport } = require('./src/parser');
const { generateReport } = require('./src/reporter');
const { enrichScanResults } = require('./src/enricher');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory job store (reset on server restart)
const jobs = new Map();

// Multer: accept HTM/HTML uploads up to 30MB
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.htm', '.html'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .htm and .html files are accepted'));
    }
  }
});

app.use(express.json());
app.use(express.static('public'));

// ── Single URL scan ──────────────────────────────────────────────────────────

app.post('/api/scan/single', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'A valid http/https URL is required.' });
  }

  try {
    const result = await scanUrl(url);
    const enrichmentMap = await enrichScanResults([result]);
    const report = generateReport([result], new URL(url).hostname, enrichmentMap);
    res.json({ success: true, violations: result.violations?.length ?? 0, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload violation report → extract URLs ───────────────────────────────────

app.post('/api/report/parse', upload.single('report'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    const urls = parseReport(req.file.path);
    fs.unlinkSync(req.file.path); // clean up temp file
    if (urls.length === 0) {
      return res.status(422).json({
        error: 'No scannable URLs were found in the report. Make sure you uploaded an IBM Accessibility Checker violation report (.htm).'
      });
    }
    res.json({ success: true, urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create a batch scan job ──────────────────────────────────────────────────

app.post('/api/jobs', (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required.' });
  }

  const validUrls = urls.filter(u => typeof u === 'string' && u.startsWith('http'));
  if (validUrls.length === 0) {
    return res.status(400).json({ error: 'No valid URLs provided.' });
  }

  const jobId = randomUUID();
  jobs.set(jobId, {
    status: 'queued',
    urls: validUrls,
    total: validUrls.length,
    progress: 0,
    currentUrl: null,
    results: [],
    report: null,
    error: null,
    createdAt: Date.now()
  });

  // Kick off the scan asynchronously
  runJob(jobId).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });

  res.json({ jobId, total: validUrls.length });
});

// ── SSE progress stream for a job ────────────────────────────────────────────

app.get('/api/jobs/:jobId/events', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const tick = () => {
    const j = jobs.get(req.params.jobId);
    if (!j) { res.end(); return; }

    send({
      status: j.status,
      progress: j.progress,
      total: j.total,
      currentUrl: j.currentUrl
    });

    if (j.status === 'complete' || j.status === 'error') {
      res.end();
    } else {
      setTimeout(tick, 600);
    }
  };

  tick();

  req.on('close', () => res.end());
});

// ── Download the completed report ────────────────────────────────────────────

app.get('/api/jobs/:jobId/report', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'complete') return res.status(400).json({ error: 'Report not ready yet.' });

  const filename = `ADA-Violation-Report-${new Date().toISOString().slice(0, 10)}.html`;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(job.report);
});

// ── Get job summary (for inline results) ─────────────────────────────────────

app.get('/api/jobs/:jobId/summary', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const totalViolations = job.results.reduce(
    (sum, r) => sum + (r.violations?.length ?? 0), 0
  );
  const errors = job.results.filter(r => r.error);

  res.json({
    status: job.status,
    total: job.total,
    scanned: job.results.length,
    totalViolations,
    errors: errors.length,
    report: job.report ?? null
  });
});

// ── Background job runner ─────────────────────────────────────────────────────

async function runJob(jobId) {
  const job = jobs.get(jobId);
  job.status = 'running';

  for (let i = 0; i < job.urls.length; i++) {
    const url = job.urls[i];
    job.currentUrl = url;
    const result = await scanUrl(url);
    job.results.push(result);
    job.progress = i + 1;
  }

  // Enrich violations with AI-generated guidance (runs in parallel per rule)
  job.status = 'enriching';
  job.currentUrl = 'Generating AI-powered guidance for violations…';
  const enrichmentMap = await enrichScanResults(job.results).catch(() => new Map());

  job.report = generateReport(job.results, '', enrichmentMap);
  job.currentUrl = null;
  job.status = 'complete';

  // Auto-clean jobs after 1 hour
  setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000);
}

// ── Cleanup uploads dir on startup ───────────────────────────────────────────

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGINT',  async () => { await closeBrowser(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`ADA Checker running at http://localhost:${PORT}`);
});
