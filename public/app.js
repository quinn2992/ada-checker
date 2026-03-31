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
    hide($('baseline-section'));
  });
});

// ── State ──────────────────────────────────────────────────────────────────

let currentJobId = null;
let currentReport = null;
let baselineReportHtml = null; // holds the uploaded violation report HTML for auto-comparison

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

  const MAX_SIZE = 30 * 1024 * 1024; // 30MB
  if (file.size > MAX_SIZE) {
    setError($('report-error'), `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 30 MB.`);
    return;
  }

  // Show a brief loading state in the drop zone
  dropZone.querySelector('.drop-label').textContent = 'Parsing report…';

  // Read file client-side to keep as baseline for auto-comparison
  const fileText = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
  baselineReportHtml = fileText;

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
    baselineReportHtml = null;
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

    if (msg.status === 'enriching') {
      updateProgress('Generating AI-powered guidance for violations…', total, total, 100);
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
  show($('baseline-section'));

  // Auto-trigger baseline comparison if a baseline report was uploaded
  if (baselineReportHtml && currentReport) {
    try {
      runBaselineComparison(baselineReportHtml);
    } catch (e) {
      // Non-fatal — comparison is optional
      console.warn('Auto-comparison failed:', e);
    }
  }

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
    const header   = section.querySelector('.rule-header');
    const ruleName = header?.querySelector('.rule-name')?.textContent || '';
    const badgeEl  = header?.querySelector('.badge');
    const impact   = badgeEl?.textContent?.toLowerCase() || 'unknown';
    const count    = header?.querySelector('.count')?.textContent || '';

    // Rule description row (help text + description)
    const descEl   = section.querySelector('.rule-description');
    const descText = descEl?.textContent?.trim().replace(/\s+/g, ' ') || '';

    // AI enrichment fields
    const importance = section.querySelector('.enrich-importance')?.textContent?.trim() || '';
    const guidance   = section.querySelector('.enrich-guidance')?.textContent?.trim()   || '';
    const audience   = section.querySelector('.enrich-audience')?.textContent?.trim()   || '';

    const enrichHtml = [
      importance ? `<div class="vg-enrich-row"><span class="vg-enrich-label">Why it matters</span><span class="vg-enrich-val">${esc(importance)}</span></div>` : '',
      guidance   ? `<div class="vg-enrich-row"><span class="vg-enrich-label">How to fix</span><span class="vg-enrich-val">${esc(guidance)}</span></div>`   : '',
      audience   ? `<div class="vg-enrich-row"><span class="vg-enrich-label">Who is affected</span><span class="vg-enrich-val">${esc(audience)}</span></div>` : ''
    ].join('');

    const instances = section.querySelectorAll('.instance');
    const instancesHtml = Array.from(instances).slice(0, 5).map(inst => {
      const url     = inst.querySelector('.instance-url a')?.textContent || '';
      const html    = inst.querySelector('code.code-block')?.textContent || '';
      const fixText = inst.querySelector('.fix-text')?.textContent?.trim() || '';
      return `
        <div class="vg-instance">
          <div class="vg-url">${esc(url)}</div>
          ${html    ? `<div class="vg-element">${esc(html)}</div>` : ''}
          ${fixText ? `<div class="vg-fix">${esc(fixText)}</div>` : ''}
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
          ${descText ? `<div class="vg-desc">${esc(descText)}</div>` : ''}
          ${enrichHtml ? `<div class="vg-enrichment">${enrichHtml}</div>` : ''}
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
  baselineReportHtml = null;
  hide($('results-section'));
  hide($('progress-section'));
  hide($('baseline-section'));
  // Reset report tab
  hide($('url-list-wrapper'));
  clearError($('report-error'));
  clearError($('single-error'));
  $('single-url').value = '';
  fileInput.value = '';
  dropZone.querySelector('.drop-label').textContent = 'Drop your violation report here';
  dropZone.querySelector('.drop-sub').textContent = 'or click to browse · Accepts .htm and .html files';
  // Reset baseline
  resetBaseline();
});

// ═══════════════════════════════════════════════════════════════════════
//  Baseline Comparison
// ═══════════════════════════════════════════════════════════════════════

// ── Cross-tool rule → WCAG criterion mapping ─────────────────────────
// Maps IBM Equal Access Checker rule IDs to their primary WCAG criteria.
// axe-core rules use tags like "wcag111" which we parse directly.
// This table is the fallback for when tags aren't available.

const IBM_TO_WCAG = {
  'WCAG20_Img_HasAlt':              '1.1.1',
  'WCAG20_Img_PresentationImgHasNonNullAlt': '1.1.1',
  'WCAG20_Input_ExplicitLabel':     '1.3.1',
  'WCAG20_Fieldset_HasLegend':      '1.3.1',
  'WCAG20_Select_HasOptGroup':      '1.3.1',
  'WCAG20_Table_Structure':         '1.3.1',
  'Rpt_Aria_OrphanedContent_Native_Host_Sematics': '1.3.1',
  'Rpt_Aria_ValidIdRef':            '1.3.1',
  'WCAG20_Label_RefValid':          '1.3.1',
  'table_aria_descendants':         '1.3.1',
  'aria_semantics_role':            '1.3.1',
  'WCAG21_Input_Autocomplete':      '1.3.5',
  'WCAG20_Text_ColorContrast':      '1.4.3',
  'IBMA_Color_Contrast_WCAG2AA':    '1.4.3',
  'IBMA_Color_Contrast_WCAG2AA_PV': '1.4.3',
  'WCAG21_Style_Viewport':          '1.4.4',
  'WCAG20_Body_FirstASkips_Native_Host_Sematics': '2.4.1',
  'WCAG20_Frame_HasTitle':          '2.4.1',
  'RPT_Html_SkipNav':               '2.4.1',
  'WCAG20_A_HasText':               '2.4.4',
  'Rpt_Aria_WidgetLabels_Implicit': '2.4.4',
  'WCAG20_Html_HasLang':            '3.1.1',
  'WCAG20_Input_HasOnchangeOrOninput': '3.2.2',
  'WCAG20_A_TargetAndText':         '3.2.5',
  'WCAG20_Input_VisibleLabel':      '3.3.2',
  'WCAG20_Input_LabelBefore':       '3.3.2',
  'WCAG20_Input_LabelAfter':        '3.3.2',
  'HAAC_Aria_ErrorMessage':         '3.3.1',
  'Rpt_Aria_ValidProperty':         '4.1.2',
  'Rpt_Aria_ValidPropertyValue':    '4.1.2',
  'HAAC_Aria_ImgAlt':               '1.1.1',
  'HAAC_Video_HasNoTrack':          '1.2.2',
  'HAAC_Audio_Video_Trigger':       '1.2.1',
  'RPT_Media_AltBrief':             '1.1.1',
  'Rpt_Aria_RequiredProperties':    '4.1.2',
  'Rpt_Aria_ValidRole':             '4.1.2',
  'WCAG20_Elem_UniqueAccessKey':    '4.1.1',
  'WCAG20_Doc_HasTitle':            '2.4.2',
  'RPT_Header_HasContent':          '1.3.1',
  'Valerie_Noembed_HasContent':     '1.1.1',
  'WCAG20_Object_HasText':          '1.1.1',
  'WCAG20_Applet_HasAlt':           '1.1.1',
  'WCAG20_Input_RadioChkInFieldSet':'1.3.1',
  'Rpt_Aria_ComplementaryLandmarkLabel_Implicit': '1.3.1',
  'Rpt_Aria_MultipleBannerLandmarks_Implicit': '1.3.1',
  'aria_hidden_focus_misuse':       '4.1.2',
};

const AXE_TO_WCAG = {
  'image-alt':            '1.1.1',
  'input-image-alt':      '1.1.1',
  'role-img-alt':         '1.1.1',
  'area-alt':             '1.1.1',
  'object-alt':           '1.1.1',
  'svg-img-alt':          '1.1.1',
  'label':                '1.3.1',
  'label-title-only':     '1.3.1',
  'aria-allowed-attr':    '4.1.2',
  'aria-required-attr':   '4.1.2',
  'aria-valid-attr':      '4.1.2',
  'aria-valid-attr-value':'4.1.2',
  'aria-roles':           '4.1.2',
  'aria-hidden-focus':    '4.1.2',
  'button-name':          '4.1.2',
  'input-button-name':    '4.1.2',
  'link-name':            '2.4.4',
  'color-contrast':       '1.4.3',
  'color-contrast-enhanced':'1.4.6',
  'document-title':       '2.4.2',
  'html-has-lang':        '3.1.1',
  'html-lang-valid':      '3.1.1',
  'valid-lang':           '3.1.2',
  'frame-title':          '2.4.1',
  'bypass':               '2.4.1',
  'skip-link':            '2.4.1',
  'duplicate-id':         '4.1.1',
  'duplicate-id-active':  '4.1.1',
  'duplicate-id-aria':    '4.1.1',
  'td-headers-attr':      '1.3.1',
  'th-has-data-cells':    '1.3.1',
  'table-fake-caption':   '1.3.1',
  'definition-list':      '1.3.1',
  'dlitem':               '1.3.1',
  'list':                 '1.3.1',
  'listitem':             '1.3.1',
  'heading-order':        '1.3.1',
  'empty-heading':        '2.4.6',
  'select-name':          '4.1.2',
  'autocomplete-valid':   '1.3.5',
  'meta-viewport':        '1.4.4',
  'meta-viewport-large':  '1.4.4',
  'form-field-multiple-labels': '1.3.1',
  'landmark-one-main':    '1.3.1',
  'region':               '1.3.1',
  'tabindex':             '2.4.3',
  'focus-order-semantics':'2.4.3',
  'target-size':          '2.5.8',
  'nested-interactive':   '4.1.2',
  'scrollable-region-focusable': '2.1.1',
};

// Fuzzy rule name matching: strip common prefixes/suffixes, normalize
function normalizeRuleName(name) {
  return name.toLowerCase()
    .replace(/^(wcag20_|wcag21_|rpt_|haac_|ibma_|rpm_|valerie_)/, '')
    .replace(/[_\-\s]+/g, '')
    .replace(/(implicit|native|host|sematics|semantics)$/g, '');
}

// ── URL normalization ─────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(u.searchParams);
    params.sort();
    const qs = params.toString();
    return `${u.protocol}//${u.hostname}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return url.replace(/\/+$/, '').replace(/\?$/, '');
  }
}

// ── Extract WCAG SC from axe-core tags ────────────────────────────────

function extractWcagFromTags(tags) {
  const scPattern = /^wcag(\d)(\d)(\d+)$/;
  const criteria = [];
  for (const tag of (tags || [])) {
    const m = tag.match(scPattern);
    if (m) {
      criteria.push(`${m[1]}.${m[2]}.${m[3]}`);
    }
  }
  return criteria;
}

// ── Parse violations from report HTML ─────────────────────────────────

function parseReportViolations(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const sections = doc.querySelectorAll('.rule-section');
  const violations = [];

  if (!sections.length) return violations;

  for (const section of sections) {
    const header = section.querySelector('.rule-header');
    const ruleNameEl = header?.querySelector('.rule-name');
    const ruleId = (ruleNameEl?.textContent || '').replace(/^Rule:\s*/i, '').trim();
    const wcagTagEl = header?.querySelector('.wcag-tag');
    const wcagTagText = wcagTagEl?.textContent?.trim() || '';
    const impactEl = header?.querySelector('.badge');
    const impact = impactEl?.textContent?.trim().toLowerCase() || '';

    // Parse WCAG tags from the displayed text (e.g. "wcag2a, wcag21aa")
    const tagList = wcagTagText.split(/,\s*/).filter(Boolean);
    const wcagCriteria = extractWcagFromTags(tagList);

    // Also try the hardcoded mappings
    if (wcagCriteria.length === 0) {
      const mapped = AXE_TO_WCAG[ruleId] || IBM_TO_WCAG[ruleId];
      if (mapped) wcagCriteria.push(mapped);
    }

    // Extract all instance URLs
    const instances = section.querySelectorAll('.instance');
    const urls = new Set();
    for (const inst of instances) {
      const urlEl = inst.querySelector('.instance-url a');
      if (urlEl) urls.add(normalizeUrl(urlEl.textContent.trim()));
    }

    violations.push({
      ruleId,
      impact,
      wcagCriteria,
      wcagTagText,
      urls: Array.from(urls),
      normalizedName: normalizeRuleName(ruleId),
      instanceCount: instances.length
    });
  }

  return violations;
}

// ── Compare baseline vs new ───────────────────────────────────────────

function compareReports(baselineViolations, newViolations) {
  function buildKeys(violations) {
    const keys = new Map();
    for (const v of violations) {
      for (const url of v.urls) {
        const normUrl = normalizeUrl(url);
        if (v.wcagCriteria.length > 0) {
          for (const sc of v.wcagCriteria) {
            const key = `${sc}|${normUrl}`;
            if (!keys.has(key)) {
              keys.set(key, { ruleId: v.ruleId, impact: v.impact, wcagCriterion: sc, urls: new Set(), wcagTagText: v.wcagTagText });
            }
            keys.get(key).urls.add(url);
          }
        } else {
          // Fallback: use normalized rule name for fuzzy matching
          const key = `rule:${v.normalizedName}|${normUrl}`;
          if (!keys.has(key)) {
            keys.set(key, { ruleId: v.ruleId, impact: v.impact, wcagCriterion: null, urls: new Set(), wcagTagText: v.wcagTagText });
          }
          keys.get(key).urls.add(url);
        }
      }
    }
    return keys;
  }

  const baselineKeys = buildKeys(baselineViolations);
  const newKeys = buildKeys(newViolations);

  const fixed = [];
  const remaining = [];
  const newFindings = [];
  const matchedNewKeys = new Set();

  for (const [key, bv] of baselineKeys) {
    if (newKeys.has(key)) {
      remaining.push({ ...bv, urls: Array.from(bv.urls) });
      matchedNewKeys.add(key);
    } else {
      fixed.push({ ...bv, urls: Array.from(bv.urls) });
    }
  }

  for (const [key, nv] of newKeys) {
    if (!matchedNewKeys.has(key)) {
      newFindings.push({ ...nv, urls: Array.from(nv.urls) });
    }
  }

  function groupByRule(items) {
    const map = new Map();
    for (const item of items) {
      const key = item.ruleId;
      if (!map.has(key)) {
        map.set(key, { ruleId: item.ruleId, impact: item.impact, wcagCriterion: item.wcagCriterion, wcagTagText: item.wcagTagText, urls: new Set() });
      }
      for (const u of item.urls) map.get(key).urls.add(u);
    }
    return Array.from(map.values()).map(g => ({ ...g, urls: Array.from(g.urls) }));
  }

  return {
    fixed: groupByRule(fixed),
    remaining: groupByRule(remaining),
    newFindings: groupByRule(newFindings)
  };
}

// ── Render comparison ─────────────────────────────────────────────────

function renderComparison(comparison) {
  const { fixed, remaining, newFindings } = comparison;

  const totalFixed = fixed.reduce((s, r) => s + r.urls.length, 0);
  const totalRemaining = remaining.reduce((s, r) => s + r.urls.length, 0);
  const totalNew = newFindings.reduce((s, r) => s + r.urls.length, 0);

  function renderCategory(icon, title, subtitle, items, emptyMsg) {
    const itemsHtml = items.length === 0
      ? `<div class="comp-empty">${esc(emptyMsg)}</div>`
      : items.map(item => {
          const wcagDisplay = item.wcagCriterion ? `WCAG ${item.wcagCriterion}` : (item.wcagTagText || '');
          return `
            <div class="comp-rule">
              <div class="comp-rule-header" onclick="toggleComp(this)">
                <span class="comp-rule-name">Rule: ${esc(item.ruleId)}</span>
                ${item.impact ? badge(item.impact) : ''}
                <span class="comp-rule-wcag">${esc(wcagDisplay)}</span>
                <span class="comp-rule-count">${item.urls.length} URL${item.urls.length !== 1 ? 's' : ''}</span>
                <span class="comp-chevron">▼</span>
              </div>
              <div class="comp-rule-body">
                ${item.urls.map(u => `<div class="comp-url-item">${esc(u)}</div>`).join('')}
              </div>
            </div>`;
        }).join('');

    const count = items.reduce((s, r) => s + r.urls.length, 0);
    return `
      <div class="comp-category">
        <div class="comp-category-header">
          <span class="comp-category-icon">${icon}</span>
          <span class="comp-category-title">${title}</span>
          <span class="comp-category-count">${count} rule/URL pair${count !== 1 ? 's' : ''}</span>
        </div>
        <p style="font-size:12px;color:#666;margin-bottom:10px">${subtitle}</p>
        ${itemsHtml}
      </div>`;
  }

  return `
    <div class="comparison-summary">
      <div class="comp-pill">
        <span class="comp-pill-icon">✅</span>
        <span class="comp-pill-value green">${totalFixed}</span>
        <span>Fixed</span>
      </div>
      <div class="comp-pill">
        <span class="comp-pill-icon">❌</span>
        <span class="comp-pill-value red">${totalRemaining}</span>
        <span>Still present</span>
      </div>
    </div>
    ${renderCategory('✅', 'Fixed — no longer detected', 'These violations appeared in the baseline report but were not found in the new scan.', fixed, 'No violations were resolved between reports.')}
    ${renderCategory('❌', 'Still Present — not yet fixed', 'These violations appear in both the baseline and the new scan.', remaining, 'No overlapping violations found — great progress!')}
  `;
}

window.toggleComp = function(header) {
  header.classList.toggle('closed');
  header.nextElementSibling.classList.toggle('hidden');
};

// ── Run comparison (shared by auto-trigger and manual upload) ─────────

function runBaselineComparison(baselineHtml) {
  const baselineViolations = parseReportViolations(baselineHtml);
  const newViolations = parseReportViolations(currentReport);
  const comparison = compareReports(baselineViolations, newViolations);
  const html = renderComparison(comparison);

  $('comparison-results').innerHTML = html;
  show($('comparison-results'));

  // Update the drop zone to show baseline is loaded
  const dropLabel = $('baseline-drop-label');
  const dropSub = $('baseline-drop-sub');
  if (dropLabel && dropSub) {
    dropLabel.textContent = '✅ Baseline loaded from uploaded report';
    dropSub.textContent = `${baselineViolations.length} rule${baselineViolations.length !== 1 ? 's' : ''} found in baseline`;
  }
}

// ── Baseline file upload handling (manual fallback for single URL tab) ─

const baselineDropZone = $('baseline-drop-zone');
const baselineFileInput = $('baseline-file-input');

baselineDropZone.addEventListener('click', () => baselineFileInput.click());

baselineDropZone.addEventListener('dragover', e => {
  e.preventDefault();
  baselineDropZone.classList.add('drag-over');
});

baselineDropZone.addEventListener('dragleave', () => baselineDropZone.classList.remove('drag-over'));

baselineDropZone.addEventListener('drop', e => {
  e.preventDefault();
  baselineDropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleBaselineUpload(file);
});

baselineFileInput.addEventListener('change', () => {
  if (baselineFileInput.files[0]) handleBaselineUpload(baselineFileInput.files[0]);
});

function handleBaselineUpload(file) {
  clearError($('baseline-error'));
  hide($('comparison-results'));

  const ext = file.name.split('.').pop().toLowerCase();
  if (!['htm', 'html'].includes(ext)) {
    setError($('baseline-error'), 'Only .htm and .html files are accepted.');
    return;
  }

  const MAX_SIZE = 30 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    setError($('baseline-error'), `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 30 MB.`);
    return;
  }

  $('baseline-drop-label').textContent = 'Parsing baseline report\u2026';

  const reader = new FileReader();
  reader.onload = function(e) {
    const html = e.target.result;

    try {
      // Validate it looks like a report
      const testDoc = new DOMParser().parseFromString(html, 'text/html');
      const hasRules = testDoc.querySelectorAll('.rule-section').length > 0;
      const hasHeader = testDoc.querySelector('.report-header');
      const hasAllClear = testDoc.querySelector('.all-clear');

      if (!hasRules && !hasHeader && !hasAllClear) {
        setError($('baseline-error'), 'This file doesn\'t appear to be a valid ADA violation report. Please upload a report generated by this tool or the IBM Equal Access Checker.');
        $('baseline-drop-label').textContent = 'Drop your baseline report here';
        $('baseline-drop-sub').textContent = 'or click to browse \u00b7 Accepts .htm and .html reports';
        return;
      }

      if (!currentReport) {
        setError($('baseline-error'), 'No current scan report to compare against. Please run a scan first.');
        $('baseline-drop-label').textContent = 'Drop your baseline report here';
        $('baseline-drop-sub').textContent = 'or click to browse \u00b7 Accepts .htm and .html reports';
        return;
      }

      baselineReportHtml = html;
      runBaselineComparison(html);

      $('baseline-drop-label').textContent = `✅ ${file.name}`;
      $('baseline-drop-sub').textContent = `Baseline loaded — comparison updated`;

      $('comparison-results').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
      setError($('baseline-error'), 'Failed to parse baseline report: ' + err.message);
      $('baseline-drop-label').textContent = 'Drop your baseline report here';
      $('baseline-drop-sub').textContent = 'or click to browse \u00b7 Accepts .htm and .html reports';
    }
  };

  reader.onerror = function() {
    setError($('baseline-error'), 'Failed to read the file. Please try again.');
    $('baseline-drop-label').textContent = 'Drop your baseline report here';
    $('baseline-drop-sub').textContent = 'or click to browse \u00b7 Accepts .htm and .html reports';
  };

  reader.readAsText(file);
}

function resetBaseline() {
  hide($('comparison-results'));
  $('comparison-results').innerHTML = '';
  clearError($('baseline-error'));
  $('baseline-drop-label').textContent = 'Drop your baseline report here';
  $('baseline-drop-sub').textContent = 'or click to browse \u00b7 Accepts .htm and .html reports';
  baselineFileInput.value = '';
}
