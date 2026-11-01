/**
 * Browser-level uptime probe: loads the key pages in a real Chromium and
 * fails on (a) missing core content and (b) page-JavaScript errors.
 *
 * Why this exists: an HTTP-200 probe happily passes while the page crashes
 * client-side (observed live when a stale rolled-back build blanked the
 * marketplace). This catches that class of failure.
 *
 * Expected noise: logged-out auth probes (401/403 "Failed to load resource")
 * are normal and ignored. Everything else fails the run.
 *
 *   node scripts/uptime-browser.mjs
 */
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const patchright = require_("patchright");

const EXPECTED_ERROR_PATTERNS = [
  /Failed to load resource: the server responded with a status of 401/,
  /Failed to load resource: the server responded with a status of 403/,
];

const browser = await patchright.chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
context.setDefaultTimeout(30000);

const problems = [];

async function checkPage(url, mustContain, consoleSink) {
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleSink.push(msg.text());
  });
  page.on("pageerror", (err) => consoleSink.push("pageerror: " + String(err)));
  try {
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(4500);
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes(mustContain)) {
      problems.push(`${url}: missing expected content "${mustContain}" (page text ${text.length} chars)`);
    }
  } catch (e) {
    problems.push(`${url}: failed to load — ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

const errors = [];
await checkPage("https://vyral.guildera.ai/", "VYRAL", errors);
await checkPage("https://vyral.guildera.ai/marketplace", "KOL Escrow Marketplace", errors);

for (const e of errors) {
  if (EXPECTED_ERROR_PATTERNS.some((p) => p.test(e))) continue;
  problems.push("console: " + e.slice(0, 300));
}

await browser.close().catch(() => {});

if (problems.length) {
  console.error("BROWSER UPTIME FAILURES:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("browser checks OK: homepage + marketplace rendered, no unexpected console errors");
