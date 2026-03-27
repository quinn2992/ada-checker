/**
 * scanner.js
 * Launches a headless Chromium browser, injects axe-core, and runs a
 * WCAG 2.1 / 2.2 Level AA accessibility scan against a given public URL.
 *
 * We reuse a single browser instance across scans for performance,
 * but each scan gets its own isolated browser context (like an incognito window).
 */

const { chromium } = require('playwright');
const axe = require('axe-core');

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

/**
 * Scan a single public URL for WCAG 2.1 / 2.2 AA violations.
 * @param {string} url - Fully qualified public URL (must be live, not sandbox)
 * @returns {object} { url, violations, passes, incomplete, error, timestamp }
 */
async function scanUrl(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; AcadeaADAChecker/1.0; +https://acadea.com)',
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  try {
    // Navigate with a generous timeout for slow-loading dynamic reports
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Extra wait for JS-rendered content (reports often load data async)
    await page.waitForTimeout(1500);

    // Inject axe-core into the page
    await page.addScriptTag({ content: axe.source });

    // Run the accessibility audit scoped to WCAG 2.1 + 2.2 AA
    const results = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
        },
        resultTypes: ['violations', 'incomplete'],
        reporter: 'v2'
      });
    });

    return {
      url,
      violations: results.violations,
      passes: results.passes.length,
      incomplete: results.incomplete,
      error: null,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    // Surface the error but don't crash the batch — the caller keeps going
    return {
      url,
      violations: [],
      passes: 0,
      incomplete: [],
      error: err.message,
      timestamp: new Date().toISOString()
    };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { scanUrl, closeBrowser };
