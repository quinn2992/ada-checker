/**
 * parser.js
 * Parses an IBM Equal Access Checker violation report (.htm / .html) and
 * extracts every unique public URL that was flagged in the report.
 *
 * Strategy:
 *  1. Load the file with cheerio (server-side jQuery-like HTML parsing)
 *  2. Pull every <a href> that is a full http/https URL
 *  3. Filter out known documentation / tool domains (IBM, W3C, etc.)
 *  4. Return deduplicated, fragment-stripped list
 *
 * This approach is intentionally liberal — if we see a real-looking URL in
 * the report that isn't a docs link, we include it. The user sees the list
 * before scanning so they can spot anything unexpected.
 */

const fs = require('fs');
const cheerio = require('cheerio');

// Domains whose links appear in the IBM report as guidance references,
// not as pages to be scanned.
const DOCS_DOMAINS = [
  'ibm.com',
  'ibm.github.io',
  'w3.org',
  'webaim.org',
  'dequeuniversity.com',
  'act-rules.github.io',
  'www.access-board.gov',
  'section508.gov'
];

function isDocsDomain(hostname) {
  return DOCS_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

/**
 * Parse an IBM violation report file and return the list of URLs to scan.
 * @param {string} filePath - Absolute path to the .htm / .html report file
 * @returns {string[]} Deduplicated array of public-facing URLs
 */
function parseReport(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(html);

  const seen = new Set();
  const urls = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();

    // Only consider full http/https URLs
    if (!href.startsWith('http://') && !href.startsWith('https://')) return;

    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return; // malformed URL
    }

    // Skip documentation/guidance domains
    if (isDocsDomain(parsed.hostname)) return;

    // Strip fragment so #section1 and #section2 of the same page don't
    // inflate the list — we scan the page once
    parsed.hash = '';
    const canonical = parsed.toString();

    if (!seen.has(canonical)) {
      seen.add(canonical);
      urls.push(canonical);
    }
  });

  return urls;
}

module.exports = { parseReport };
