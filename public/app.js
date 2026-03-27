/* ── app.js — ADA Accessibility Re-Checker frontend ──────────────────── */

'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setError(el, msg) {
  el.textContent = msg;
  show(el);
}

function clearError(el) {
  el.textContent = '';
  hide(el);
}

const IMPACT_COLORS = {
  critical: '#c7221f',
  serious:  '#e05c00',
  moderate: '#b38600',
  minor:    '#1a6896'
};

function badge(impact) {
  const color = IMPACT_COLORS[impact] || '#555';
  return `<span class="badge" style="background:${color}">${esc(impact || 'unknown')}</span>`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    // Hide results / progress when switching tabs
    hide($('progress-section'));
    hide($('results-section'));
  });
});

// ── State ──────────────────────────────────────────────────────────────────

let currentJobId = null;
let currentReport = null;

// ── Single URL scan ────────────────────────────────────────────────────────

$('btn-scan-single').addEventListener('click', () => {
  const url = $('single-url').value.trim();
  clearError($('single-error'));

  if (!url) {
    setError($('single-error'), 'Please enter a URL.');
    return;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    setError($('single-error'), 'URL must start with http:// or https://');
    return;
  }

  startSingleScan(url);
});

$('single-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-scan-single').click();
});

async function startSingleScan(url) {
  showProgress('Scanning URL…', `Scanning: ${url}`, null, null);

  try {
    const res = await fetch('/api/scan/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed.');

    currentReport = data.report;
    showResults([{
      url,
      violations: data.violations,
      passes: 0
    }], data.report, data.violations);

  } catch (err) {
    hideProgress();
    setError($('single-error'), err.message);
  }
}

// ── File upload & parsing ──────────────────────────────────────────────────

const dropZone  = $('drop-zone');
const fileInput = $('file-input');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileUpload(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
});

async function handleFileUpload(file) {
  clearError($('report-error'));
  hide($('url-list-wrapper'));

  const ext = file.name.split('.').pop().toLowerCase();
  if (!['htm', 'html'].includes(ext)) {
    setError($('report-error'), 'Only .htm and .html files are accepted.');
    return;
  }

  // Show a brief loading state in the drop zone
  dropZone.querySelector('.drop-label').textContent = 'Parsing report…';

  const form = new FormData();
  form.append('report', file);

  try {
    const res = await fetch('/api/report/parse', { method: 'POST', body: form });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to parse report.');

    populateUrlList(data.urls);
    dropZone.querySelector('.drop-label').textContent = `✅ ${file.name}`;
    dropZone.querySelector('.drop-sub').textContent = `${data.urls.length} URLs extracted — ready to scan`;

  } catch (err) {
    dropZone.querySelector('.drop-label').textContent = 'Drop your violation report here';
    dropZone.querySelector('.drop-sub').textContent = 'or click to browse · Accepts .htm and .html files';
    setError($('report-error'), err.message);
  }
}

function populateUrlList(urls) {
  const list = $('url-list');
  list.innerHTML = urls.map((url, i) => `
    <div class="url-list-item">
      <input type="checkbox" id="url-${i}" checked data-url="${esc(url)}">
      <label for="url-${i}" class="url-text">${esc(url)}</label>
    </div>
  `).join('');

  $('url-count').textContent = `${urls.length} URL${urls.length !== 1 ? 's' : ''}`;
  show($('url-list-wrapper'));
}

$('btn-select-all').addEventListener('click', () => {
  $('url-list').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
});

$('btn-deselect-all').addEventListener('click', () => {
  $('url-list').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
});

// ── Batch scan from report ─────────────────────────────────────────────────

$('btn-scan-report').addEventListener('click', () => {
  const checked = Array.from(
    $('url-list').querySelectorAll('input[type="checkbox"]:checked')
  ).map(cb => cb.dataset.url);

  clearError($('report-error'));

  if (checked.length === 0) {
    setError($('report-error'), 'Please select at least one URL to scan.');
    return;
  }

  startBatchScan(checked);
});

async function startBatchScan(urls) {
  showProgress(
    `Scanning ${urls.length} URL${urls.length !== 1 ? 's' : ''}…`,
    'Starting…',
    0,
    urls.length
  );

  try {
    // Create the job
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start scan.');

    currentJobId = data.jobId;
    pollJob(currentJobId, urls.length);

  } catch (err) {
    hideProgress();
    setError($('report-error'), err.message);
  }
}

// ── Job polling via SSE ────────────────────────────────────────────────────

function pollJob(jobId, total) {
  const es = new EventSource(`/api/jobs/${jobId}/events`);

  es.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.status === 'running' || msg.status === 'queued') {
      const pct = total > 0 ? Math.round((msg.progress / total) * 100) : 0;
      updateProgress(
        msg.currentUrl ? `Scanning: ${msg.currentUrl}` : 'Starting…',
        msg.progress,
        total,
        pct
      );
    }

    if (msg.status === 'complete') {
      es.close();
      await fetchAndShowResults(jobId);
    }

    if (msg.status === 'error') {
      es.close();
      hideProgress();
      setError($('report-error'), 'An error occurred during the scan. Please try again.');
    }
  };

  es.onerror = () => {
    es.close();
    // Try fetching results anyway — job may have completed
    fetchAndShowResults(jobId).catch(() => {
      hideProgress();
      setError($('report-error'), 'Connection lost. Please try again.');
    });
  };
}

async function fetchAndShowResults(jobId) {
  const res = await fetch(`/api/jobs/${jobId}/summary`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  currentReport = data.report;
  showResults(null, data.report, data.totalViolations, data.scanned, data.errors);
}

// ── Progress UI ────────────────────────────────────────────────────────────

function showProgress(title, label, current, total) {
  hide($('results-section'));
  $('progress-title').textContent = title;
  $('progress-label').textContent = label;
  $('progress-bar').style.width = '0%';
  $('progress-count').textContent = total != null ? `0 of ${total}` : '';
  show($('progress-section'));
}

function updateProgress(label, current, total, pct) {
  $('progress-label').textContent = label;
  $('progress-bar').style.width = `${pct}%`;
  $('progress-count').textContent = `${current} of ${total} URLs scanned`;
}

function hideProgress() {
  hide($('progress-section'));
}

// ── Results UI ─────────────────────────────────────────────────────────────

/**
 * @param {object[]|null} results  - Per-URL results (only available for single-URL scans from API)
 * @param {string}        report   - Full HTML report string
 * @param {number}        totalViolations
 * @param {number}        [scanned]
 * @param {number}        [errors]
 */
function showResults(results, report, totalViolations, scanned, errors) {
  hideProgress();

  // Summary pills
  const pills = $('summary-pills');
  pills.innerHTML = `
    <div class="pill">
      <span class="pill-value ${totalViolations > 0 ? 'red' : ''}">${totalViolations}</span>
      <span>Violations found</span>
    </div>
    ${scanned != null ? `<div class="pill"><span class="pill-value">${scanned}</span><span>URLs scanned</span></div>` : ''}
    ${errors != null && errors > 0 ? `<div class="pill"><span class="pill-value red">${errors}</span><span>Scan errors</span></div>` : ''}
  `;

  // Violations list (parsed from the report HTML for inline display)
  const violationsDiv = $('violations-list');
  if (totalViolations === 0) {
    violationsDiv.innerHTML = `
      <div class="violation-group" style="text-align:center; padding: 50px 30px; background:#fff; border:1px solid #d5f5e3; border-radius:8px;">
        <div style="font-size:48px">✅</div>
        <p style="font-size:18px; font-weight:700; color:#155724; margin-top:14px">No violations detected!</p>
        <p style="color:#666; font-size:14px; margin-top:6px">All scanned URLs passed WCAG 2.1 / 2.2 Level AA automated checks.</p>
      </div>`;
  } else {
    // Parse the report HTML to build an inline preview
    violationsDiv.innerHTML = buildInlinePreview(report);
  }

  show($('results-section'));
  $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Pull violation sections out of the generated report HTML for inline display.
 * We do this by parsing the report HTML in a detached DOM so we don't need
 * a separate API endpoint just for the inline view.
 */
function buildInlinePreview(reportHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(reportHtml, 'text/html');
  const sections = doc.querySelectorAll('.rule-section');

  if (!sections.length) return '<p style="color:#666;font-size:13px">No preview available — download the report to view results.</p>';

  return Array.from(sections).map(section => {
    const header  = section.querySelector('.rule-header');
    const ruleName = header?.querySelector('.rule-name')?.textContent || '';
    const badgeEl  = header?.querySelector('.badge');
    const impact   = badgeEl?.textContent?.toLowerCase() || 'unknown';
    const count    = header?.querySelector('.count')?.textContent || '';

    const instances = section.querySelectorAll('.instance');
    const instancesHtml = Array.from(instances).slice(0, 5).map(inst => {
      const url  = inst.querySelector('.instance-url a')?.textContent || '';
      const html = inst.querySelector('code.code-block')?.textContent || '';
      return `
        <div class="vg-instance">
          <div class="vg-url">${esc(url)}</div>
          ${html ? `<div class="vg-element">${esc(html)}</div>` : ''}
        </div>`;
    }).join('');

    const more = instances.length > 5
      ? `<div style="padding:10px 16px;font-size:12px;color:#888;border-top:1px solid #eee">+ ${instances.length - 5} more — download full report to view all</div>`
      : '';

    return `
      <div class="violation-group">
        <div class="vg-header" onclick="toggleVG(this)">
          <span class="vg-name">${esc(ruleName)}</span>
          ${badge(impact)}
          <span style="font-size:13px;color:#666">${esc(count)}</span>
          <span class="vg-chevron">▼</span>
        </div>
        <div class="vg-body">
          ${instancesHtml}
          ${more}
        </div>
      </div>`;
  }).join('');
}

window.toggleVG = function(header) {
  header.classList.toggle('closed');
  header.nextElementSibling.classList.toggle('hidden');
};

// ── Download report ────────────────────────────────────────────────────────

$('btn-download').addEventListener('click', () => {
  if (!currentReport) return;

  if (currentJobId) {
    // Batch: download via server endpoint so it gets the right filename
    window.location.href = `/api/jobs/${currentJobId}/report`;
  } else {
    // Single URL: report is in memory, trigger download client-side
    const blob = new Blob([currentReport], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ADA-Violation-Report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
});

// ── New scan ───────────────────────────────────────────────────────────────

$('btn-new-scan').addEventListener('click', () => {
  currentJobId = null;
  currentReport = null;
  hide($('results-section'));
  hide($('progress-section'));
  // Reset report tab
  hide($('url-list-wrapper'));
  clearError($('report-error'));
  clearError($('single-error'));
  $('single-url').value = '';
  fileInput.value = '';
  dropZone.querySelector('.drop-label').textContent = 'Drop your violation report here';
  dropZone.querySelector('.drop-sub').textContent = 'or click to browse · Accepts .htm and .html files';
});
