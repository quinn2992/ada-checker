/**
 * reporter.js
 * Generates an HTML violation report from axe-core scan results.
 * The format deliberately mirrors the IBM Equal Access Checker report
 * that customers already received, so the output looks familiar.
 *
 * Layout:
 *   - Header  (title, date, counts)
 *   - Summary bar  (violations / rules triggered / URLs / errors)
 *   - One collapsible section per violation rule, sorted by impact
 *   - Under each rule: every affected URL + element detail table
 *   - If zero violations: a green "all clear" card
 */

// ── Impact helpers ─────────────────────────────────────────────────────────

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

const IMPACT_COLORS = {
  critical: '#c7221f',
  serious:  '#e05c00',
  moderate: '#b38600',
  minor:    '#1a6896'
};

function impactColor(impact) {
  return IMPACT_COLORS[impact] || '#555';
}

function impactBadge(impact) {
  const color = impactColor(impact);
  return `<span class="badge" style="background:${color}">${escapeHtml(impact || 'unknown')}</span>`;
}

// ── WCAG tag → human label ─────────────────────────────────────────────────

function wcagLabel(tags = []) {
  const wcag = tags.filter(t => t.startsWith('wcag')).slice(0, 3);
  return wcag.length ? wcag.join(', ') : 'WCAG';
}

// ── Safe HTML escaping ──────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

// ── Build rule map from results ────────────────────────────────────────────

function buildRuleMap(scanResults) {
  const ruleMap = new Map();

  for (const result of scanResults) {
    if (result.error || !result.violations) continue;

    for (const violation of result.violations) {
      if (!ruleMap.has(violation.id)) {
        ruleMap.set(violation.id, {
          id:          violation.id,
          description: violation.description,
          help:        violation.help,
          helpUrl:     violation.helpUrl,
          impact:      violation.impact,
          tags:        violation.tags || [],
          instances:   []
        });
      }

      const rule = ruleMap.get(violation.id);
      for (const node of violation.nodes) {
        rule.instances.push({
          url:            result.url,
          html:           node.html || '',
          target:         (node.target || []).join(', '),
          failureSummary: node.failureSummary || ''
        });
      }
    }
  }

  return ruleMap;
}

// ── HTML snippets ──────────────────────────────────────────────────────────

function renderInstance(inst) {
  return `
      <div class="instance">
        <div class="instance-url">
          <a href="${escapeHtml(inst.url)}" target="_blank" rel="noopener">${escapeHtml(inst.url)}</a>
        </div>
        <table class="detail-table">
          <tr>
            <td class="lbl">Element</td>
            <td><code class="code-block">${escapeHtml(inst.html)}</code></td>
          </tr>
          <tr>
            <td class="lbl">Selector</td>
            <td><code>${escapeHtml(inst.target)}</code></td>
          </tr>
          <tr>
            <td class="lbl">Fix needed</td>
            <td class="fix-text">${escapeHtml(inst.failureSummary)}</td>
          </tr>
        </table>
      </div>`;
}

function renderEnrichment(enrichment) {
  if (!enrichment || (!enrichment.importance && !enrichment.guidance && !enrichment.audience)) {
    return '';
  }
  const rows = [
    { label: 'Why it matters', value: enrichment.importance, cls: 'enrich-importance' },
    { label: 'How to fix',     value: enrichment.guidance,   cls: 'enrich-guidance'   },
    { label: 'Who is affected',value: enrichment.audience,   cls: 'enrich-audience'   }
  ].filter(r => r.value);

  if (!rows.length) return '';

  return `
        <div class="rule-enrichment">
          ${rows.map(r => `
          <div class="enrich-item">
            <div class="enrich-label">${escapeHtml(r.label)}</div>
            <div class="enrich-value ${r.cls}">${escapeHtml(r.value)}</div>
          </div>`).join('')}
        </div>`;
}

function renderRule(rule, enrichment) {
  const instancesHtml = rule.instances.map(renderInstance).join('');
  return `
    <div class="rule-section">
      <div class="rule-header" onclick="toggle(this)">
        <span class="rule-name">Rule: ${escapeHtml(rule.id)}</span>
        <span class="rule-meta">
          ${impactBadge(rule.impact)}
          <span class="wcag-tag">${escapeHtml(wcagLabel(rule.tags))}</span>
          <span class="count">${rule.instances.length} violation${rule.instances.length !== 1 ? 's' : ''}</span>
        </span>
        <span class="chevron">▼</span>
      </div>
      <div class="rule-body">
        <div class="rule-description">
          <strong>${escapeHtml(rule.help)}</strong>
          &nbsp;—&nbsp;${escapeHtml(rule.description)}
          &nbsp;<a href="${escapeHtml(rule.helpUrl)}" target="_blank" rel="noopener">Learn more →</a>
        </div>
        ${renderEnrichment(enrichment)}
        ${instancesHtml}
      </div>
    </div>`;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate an HTML report from an array of scan results.
 * @param {object[]} scanResults   - Array returned by scanner.scanUrl()
 * @param {string}   [label]       - Optional label (e.g. hostname) for the title
 * @param {Map}      [enrichmentMap] - ruleId → { importance, guidance, audience }
 * @returns {string} Full HTML document
 */
function generateReport(scanResults, label = '', enrichmentMap = new Map()) {
  const timestamp   = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
  const totalUrls   = scanResults.length;
  const errorCount  = scanResults.filter(r => r.error).length;

  const ruleMap     = buildRuleMap(scanResults);
  const sortedRules = Array.from(ruleMap.values()).sort(
    (a, b) => (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4)
  );

  const totalViolations = sortedRules.reduce((s, r) => s + r.instances.length, 0);

  // ── Error section ──────────────────────────────────────────────────────
  const errorHtml = scanResults.filter(r => r.error).map(r => `
    <div class="error-item">
      <span class="err-icon">⚠️</span>
      <span><strong>${escapeHtml(r.url)}</strong><br>
      <span class="err-msg">${escapeHtml(r.error)}</span></span>
    </div>`).join('');

  // ── Rules / no-violations section ─────────────────────────────────────
  const mainHtml = sortedRules.length === 0
    ? `<div class="all-clear">
        <div class="all-clear-icon">✅</div>
        <p class="all-clear-title">No violations detected</p>
        <p class="all-clear-sub">All scanned URLs passed WCAG 2.1 / 2.2 Level AA automated checks.</p>
       </div>`
    : sortedRules.map(rule => renderRule(rule, enrichmentMap.get(rule.id))).join('');

  const titleStr = label ? ` — ${escapeHtml(label)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA Violation Report${titleStr}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
           background: #f0f2f5; color: #222; font-size: 14px; line-height: 1.5; }

    /* ── Header ── */
    .report-header { background: #1a2744; color: #fff; padding: 28px 40px 20px; }
    .report-header h1 { font-size: 22px; font-weight: 700; letter-spacing: -.3px; }
    .report-accent  { height: 4px; background: #d9342e; }
    .report-meta    { margin-top: 8px; font-size: 13px; opacity: .75; }

    /* ── Summary bar ── */
    .summary { background: #fff; border-bottom: 1px solid #dde0e6;
               display: flex; gap: 0; }
    .stat { flex: 1; padding: 20px 24px; text-align: center;
            border-right: 1px solid #eee; }
    .stat:last-child { border-right: none; }
    .stat-value { font-size: 30px; font-weight: 800; color: #1a2744; }
    .stat-value.red { color: #c7221f; }
    .stat-label { font-size: 12px; color: #666; margin-top: 3px; text-transform: uppercase;
                  letter-spacing: .5px; }

    /* ── Content area ── */
    .content { max-width: 1100px; margin: 28px auto; padding: 0 32px 60px; }

    /* ── Error block ── */
    .error-block { background: #fff8f8; border: 1px solid #f5c0c0;
                   border-radius: 6px; padding: 20px; margin-bottom: 20px; }
    .error-block h3 { color: #c7221f; margin-bottom: 12px; font-size: 14px; }
    .error-item { display: flex; gap: 10px; margin-bottom: 10px; font-size: 13px; }
    .err-icon   { flex-shrink: 0; }
    .err-msg    { color: #888; font-size: 12px; }

    /* ── Rule sections ── */
    .rule-section { background: #fff; border: 1px solid #dde0e6;
                    border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
    .rule-header  { display: flex; align-items: center; gap: 12px;
                    padding: 13px 18px; cursor: pointer; background: #f7f8fa;
                    user-select: none; }
    .rule-header:hover { background: #eef0f4; }
    .rule-header.closed .chevron { transform: rotate(-90deg); }
    .rule-body.hidden { display: none; }
    .rule-name  { flex: 1; font-weight: 700; font-size: 13px; }
    .rule-meta  { display: flex; align-items: center; gap: 8px; }
    .wcag-tag   { font-size: 11px; color: #666; font-family: monospace; }
    .count      { font-size: 13px; color: #444; }
    .chevron    { font-size: 11px; color: #888; transition: transform .15s; }

    /* ── Badge ── */
    .badge { display: inline-block; color: #fff; font-size: 10px; font-weight: 700;
             text-transform: uppercase; letter-spacing: .5px;
             padding: 2px 8px; border-radius: 3px; }

    /* ── Rule description row ── */
    .rule-description { padding: 14px 20px; background: #fafbfc;
                        border-bottom: 1px solid #eee; font-size: 13px; color: #444; }
    .rule-description a { color: #1a5276; }

    /* ── Enrichment panel (AI-generated Importance / Guidance / Audience) ── */
    .rule-enrichment { border-bottom: 1px solid #eee; background: #f9f9ff; padding: 0 20px; }
    .enrich-item { display: flex; gap: 0; border-bottom: 1px solid #eef; padding: 10px 0; }
    .enrich-item:last-child { border-bottom: none; }
    .enrich-label { width: 130px; flex-shrink: 0; font-size: 11px; font-weight: 700;
                    text-transform: uppercase; letter-spacing: .4px; color: #555;
                    padding-top: 2px; }
    .enrich-value { flex: 1; font-size: 13px; color: #333; line-height: 1.55; }

    /* ── Instance ── */
    .instance { border-top: 1px solid #eee; padding: 18px 20px; }
    .instance:first-of-type { border-top: none; }
    .instance-url { margin-bottom: 10px; }
    .instance-url a { color: #1a5276; font-size: 12px; word-break: break-all; }

    /* ── Detail table ── */
    .detail-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .detail-table td { padding: 7px 10px; vertical-align: top;
                       border-bottom: 1px solid #f2f2f2; }
    .detail-table tr:last-child td { border-bottom: none; }
    .lbl { width: 110px; font-weight: 600; color: #555; white-space: nowrap; }
    code { background: #f4f5f7; padding: 2px 6px; border-radius: 3px;
           font-size: 12px; font-family: 'SFMono-Regular', Consolas, monospace; }
    .code-block { word-break: break-all; white-space: pre-wrap; display: block;
                  max-height: 80px; overflow: auto; }

    /* ── All clear ── */
    .all-clear { background: #fff; border: 1px solid #b7e4c7; border-radius: 6px;
                 padding: 60px 40px; text-align: center; }
    .all-clear-icon  { font-size: 52px; }
    .all-clear-title { margin-top: 16px; font-size: 20px; font-weight: 700; color: #155724; }
    .all-clear-sub   { margin-top: 8px; color: #666; font-size: 14px; }

    /* ── Print ── */
    @media print {
      .rule-body.hidden { display: block !important; }
      .rule-header { cursor: default; }
    }
  </style>
</head>
<body>

<div class="report-header">
  <h1>ADA Violation Report${titleStr}</h1>
  <div class="report-meta">URLs Scanned: ${totalUrls} &nbsp;|&nbsp; Total Violations: ${totalViolations} &nbsp;|&nbsp; Generated: ${timestamp}</div>
</div>
<div class="report-accent"></div>

<div class="summary">
  <div class="stat">
    <div class="stat-value red">${totalViolations}</div>
    <div class="stat-label">Violations Found</div>
  </div>
  <div class="stat">
    <div class="stat-value">${sortedRules.length}</div>
    <div class="stat-label">Rules Triggered</div>
  </div>
  <div class="stat">
    <div class="stat-value">${totalUrls}</div>
    <div class="stat-label">URLs Scanned</div>
  </div>
  <div class="stat">
    <div class="stat-value${errorCount > 0 ? ' red' : ''}">${errorCount}</div>
    <div class="stat-label">Scan Errors</div>
  </div>
</div>

<div class="content">
  ${errorHtml ? `<div class="error-block"><h3>⚠️ Scan Errors — these URLs could not be reached</h3>${errorHtml}</div>` : ''}
  ${mainHtml}
</div>

<script>
  function toggle(header) {
    header.classList.toggle('closed');
    header.nextElementSibling.classList.toggle('hidden');
  }
  // Start all sections expanded (consistent with IBM report default)
</script>
</body>
</html>`;
}

module.exports = { generateReport };
