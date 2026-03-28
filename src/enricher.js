/**
 * enricher.js
 * Uses Claude (claude-opus-4-6) to generate Importance, Guidance, and Audience
 * context for each unique axe-core violation rule found in a scan.
 *
 * Results are cached in-memory by rule ID so we never call the API twice
 * for the same rule type across multiple scans in the same server session.
 */

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function getClient() {
  if (!_client && process.env.ANTHROPIC_API_KEY) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Persistent in-memory cache: ruleId → { importance, guidance, audience }
const cache = new Map();

/**
 * Enrich a single violation rule with AI-generated guidance.
 * @param {{ id, description, help, impact }} rule
 * @returns {{ importance, guidance, audience }}
 */
async function enrichViolation(rule) {
  if (cache.has(rule.id)) return cache.get(rule.id);

  const client = getClient();
  if (!client) return { importance: '', guidance: '', audience: '' };

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: 'You are a WCAG 2.1 accessibility expert. Respond with valid JSON only — no markdown fences, no explanation outside the JSON.',
    messages: [{
      role: 'user',
      content: `Provide structured guidance for this WCAG accessibility violation.

Rule ID: ${rule.id}
Description: ${rule.description}
Help text: ${rule.help}
Impact: ${rule.impact}

Return exactly this JSON structure:
{
  "importance": "2–3 sentences explaining why this violation matters and its real-world impact on users with disabilities.",
  "guidance": "Specific, actionable steps to fix this. Number the steps if there are multiple actions.",
  "audience": "Comma-separated list of affected user groups (e.g., Screen reader users, Keyboard-only users, Users with low vision, Colour-blind users)"
}`
    }]
  });

  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);

  let parsed = {};
  try { parsed = match ? JSON.parse(match[0]) : {}; } catch { /* leave empty */ }

  const result = {
    importance: String(parsed.importance || '').trim(),
    guidance:   String(parsed.guidance   || '').trim(),
    audience:   String(parsed.audience   || '').trim()
  };

  cache.set(rule.id, result);
  return result;
}

/**
 * Enrich all unique violation rules found across an array of scan results.
 * Runs enrichments in parallel; gracefully degrades if the API key is missing
 * or any individual call fails.
 *
 * @param {object[]} scanResults - Array returned by scanner.scanUrl()
 * @returns {Map<string, {importance, guidance, audience}>} ruleId → enrichment
 */
async function enrichScanResults(scanResults) {
  const client = getClient();
  if (!client) return new Map();

  // Deduplicate rules across all results
  const uniqueRules = new Map();
  for (const result of scanResults) {
    if (!result.violations) continue;
    for (const v of result.violations) {
      if (!uniqueRules.has(v.id)) {
        uniqueRules.set(v.id, {
          id:          v.id,
          description: v.description || '',
          help:        v.help        || '',
          impact:      v.impact      || ''
        });
      }
    }
  }

  if (uniqueRules.size === 0) return new Map();

  // Enrich all unique rules in parallel
  const enrichmentMap = new Map();
  await Promise.all(
    Array.from(uniqueRules.values()).map(async rule => {
      const enrichment = await enrichViolation(rule).catch(() => ({
        importance: '', guidance: '', audience: ''
      }));
      enrichmentMap.set(rule.id, enrichment);
    })
  );

  return enrichmentMap;
}

module.exports = { enrichScanResults };
