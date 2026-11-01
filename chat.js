/**
 * Read X Chat for DM-code ownership matches — 2026 embedded-chat edition.
 *
 * Usage:
 *   node chat.js --expect-code vyral-ABCD234 [--expected somehandle] --json
 *
 * Proof model (see turso-schema-x-dm-codes.sql):
 *   the pass verifies only when a conversation WITH the expected handle
 *   contains the exact code. Sender handles cannot be forged in DMs, so a
 *   leaked code sent from another account matches nothing.
 *
 * How the 2026 X Chat app works (probed live, see probe-chat-*.mjs):
 *   - /i/chat renders `xchatEmbedRoute` with an OPEN SHADOW ROOT; everything
 *     is in there. Playwright locators pierce open shadow roots by default.
 *   - an inbox list is unstable/empty for request-gated threads, so the
 *     reader does NOT scan lists: it dereferences each claimed handle through
 *     the composer's recipient search (new-dm-search-input) and opens that
 *     conversation directly. Whether it sits in the inbox, requests or a
 *     request-gated panel (dm-message-request-prompt), the messages are
 *     readable in dm-message-list.
 *   - the participant is confirmed from the thread's own texts (header and
 *     the request prompt both carry "@<handle>"), not from guessed markup.
 *   - the composer suggestion row id carries the X USER ID, recorded as
 *     sender evidence.
 *
 * Hard-won robustness (live observations, Nov 2026):
 *   - waits are READINESS POLLS, never fixed sleeps (fast when X renders
 *     fast; budgets never below the old fixed waits).
 *   - X can RE-LOCK the passcode wall in the middle of a run (pin elements
 *     and an open composer coexist) — every pass re-enters the PIN when the
 *     wall is up, and the message poll aborts + retries when it re-locks.
 *   - a suggestion row can exist before its TEXT hydrates — the row wait
 *     matches on (id-prefix AND text), not id alone.
 *   - a click on a just-hydrated row can be swallowed — the reader verifies
 *     the conversation actually opened and retries the click once.
 *   - HONESTY: opened the conversation but never saw a single message is
 *     NOT a clean read — read_ok:false (retryable infra), never "no_match".
 *
 * Session behaviour:
 *   - the login comes from state.json (same file as verify.js)
 *   - X Chat locks behind a passcode; it is entered once per session from
 *     CHAT_PIN (never logged, never stored in the output) and RE-ENTERED
 *     whenever X re-locks mid-run.
 *
 * Environment:
 *   CHAT_PIN            the account's chat passcode (falls back to "2005"
 *                       ONLY when X_ALLOW_DEFAULT=1 is also set; production
 *                       must set CHAT_PIN or the reader refuses to run)
 *   X_STATE_PATH        session file, as in verify.js
 *   X_STATE             base64 session (CI) — written to state-ci.json
 *
 * Output (--json): a JSON document. Whole threads are intentionally NOT
 * returned — only matches, ids and counts.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { codes: [], expected: [], json: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect-code") args.codes.push((argv[++i] || "").trim());
    else if (a === "--expected") args.expected.push((argv[++i] || "").trim());
    else if (a === "--json") args.json = true;
    else if (a === "--max") void ++i; // kept for CLI compatibility; unused
  }
  args.codes = args.codes.filter(Boolean);
  args.expected = args.expected.map((h) => h.toLowerCase().replace(/^@+/, "")).filter(Boolean);
  return args;
}

function result({ ok, error = null, read_conversations = 0, requests_checked = false, matches = [], passcode_entered = false, read_ok = false }) {
  return {
    reader: "chat",
    ok,
    error,
    // true ONLY when chat was actually opened and scanned. Separates "clean
    // read, the code is not there yet" (a verdict) from "could not read"
    // (infrastructure). Callers must never turn the first into a rejection.
    read_ok,
    read_conversations,
    requests_checked,
    matches,
    passcode_entered,
    checkedAt: new Date().toISOString(),
  };
}

const CODE_RE = /vyral[-_ ]?([A-Z2-9]{8})/gi;

function codeMatches(text) {
  if (!text) return [];
  const hits = [];
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(text)) !== null) {
    hits.push("vyral-" + m[1].toUpperCase());
  }
  return hits;
}

/**
 * Readiness polling: wait until probe() is truthy, up to the budget.
 * Replaces fixed sleeps — fast when X renders quickly, equally patient when
 * it doesn't (budgets are <= the old fixed waits, so the worst case is
 * unchanged; the typical case saves seconds on every step).
 */
async function waitUntil(page, budgetMs, probe) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let ready = false;
    try {
      ready = await probe();
    } catch {
      ready = false;
    }
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(650);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const pin = process.env.CHAT_PIN || (process.env.X_ALLOW_DEFAULT === "1" ? "2005" : "");
  if (!pin) {
    console.log(JSON.stringify(result({ ok: false, error: "CHAT_PIN not configured" })));
    process.exitCode = 1;
    return;
  }
  if (args.codes.length === 0) {
    console.log(JSON.stringify(result({ ok: false, error: "no codes to expect (--expect-code)" })));
    process.exitCode = 1;
    return;
  }

  let patchright;
  try {
    patchright = require_("patchright");
  } catch (e) {
    console.log(JSON.stringify(result({ ok: false, error: "patchright not installed: " + e.message })));
    process.exitCode = 1;
    return;
  }

  let storageStatePath = path.join(here, "state.json");
  if (process.env.X_STATE_PATH && fs.existsSync(process.env.X_STATE_PATH)) {
    storageStatePath = process.env.X_STATE_PATH;
  } else if (process.env.X_STATE) {
    storageStatePath = path.join(here, "state-ci.json");
    fs.writeFileSync(storageStatePath, Buffer.from(process.env.X_STATE, "base64").toString());
  }

  const browser = await patchright.chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    storageState: fs.existsSync(storageStatePath) ? storageStatePath : undefined,
  });
  context.setDefaultTimeout(20000);

  const page = await context.newPage();
  const out = result({ ok: false });

  // ---- passcode helpers (the wall can appear AND RE-appear) ----------------
  const wallUp = async () => (await page.locator('input[maxlength="1"]').count()) >= 4;
  const enterPin = async () => {
    const inputs = await page.locator('input[maxlength="1"]').all();
    if (inputs.length < 4) return false;
    for (let i = 0; i < 4; i++) {
      await inputs[i].click();
      await page.keyboard.type(pin[i], { delay: 100 });
      await page.waitForTimeout(120);
    }
    out.passcode_entered = true;
    await waitUntil(page, 7000, async () =>
      (await page.locator('[data-testid="dm-new-chat-button"]').count()) > 0
    );
    return true;
  };

  try {
    // ---- open chat ---------------------------------------------------------
    await page.goto("https://x.com/i/chat", { waitUntil: "load", timeout: 60000 });
    // Wait for EITHER the passcode wall or the chat inbox — whichever X
    // renders first — instead of a fixed 6s nap.
    await waitUntil(page, 7000, async () => {
      if ((await page.locator('input[maxlength="1"]').count()) >= 4) return true;
      return (await page.locator('[data-testid="dm-new-chat-button"]').count()) > 0;
    });
    if (!/\/i\/chat/.test(page.url())) {
      out.error = "Chat route did not open (redirected to " + page.url() + ")";
      console.log(JSON.stringify(out));
      process.exitCode = 1;
      return;
    }

    if (await wallUp()) {
      await enterPin();
    } else {
      // Either no wall (chat directly reachable) or logged out entirely.
      const walled = await page.locator('[data-testid="loginButton"], [data-testid="signupButton"]').count();
      const authenticated = (await page.locator('[data-testid="dm-new-chat-button"]').count()) > 0;
      if (!authenticated) {
        out.error =
          walled > 0
            ? "Login wall detected. Session expired — run: node login.js"
            : "Chat did not open and no passcode prompt was found";
        console.log(JSON.stringify(out));
        process.exitCode = 1;
        return;
      }
    }

    if (/pin\/recovery/.test(page.url())) {
      out.error = "Chat still passcode-locked after entry — wrong CHAT_PIN?";
      console.log(JSON.stringify(out));
      process.exitCode = 1;
      return;
    }

    // ---- dereference conversations by handle --------------------------------
    // Handles cannot be trusted from list previews; each claimed handle is
    // opened through the composer search so the thread CERTAINLY belongs to
    // it, then participant + message texts are read from the open thread.
    const wantedCodes = args.codes.map((c) => c.toUpperCase());
    const matches = [];
    let threadsRead = 0;
    let couldNotRead = false;

    for (const expected of args.expected.length ? args.expected : [null]) {
      let thread = null;
      let lastTrail = [];
      let lastRead = 0;
      let lastEmpty = false;
      let openSaw = false;
      let senderUserId = null;
      let lastError = null;
      let readerReached = false;

      // Up to 3 passes: X can re-lock the passcode wall mid-run (observed
      // live), swallow a just-hydrated row click, or simply serve history
      // slowly. Each pass recovers the wall and starts the dereference over.
      for (let pass = 0; pass < 3; pass++) {
        if (pass > 0) {
          // Close a composer modal a failed pass may have left open.
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(400);
        }

        // (Re)enter the PIN whenever the wall is (back) up.
        if (await wallUp()) {
          await enterPin();
          if (/pin\/recovery/.test(page.url())) {
            await page.waitForTimeout(1500);
            if (await wallUp()) await enterPin();
          }
          if (/pin\/recovery/.test(page.url())) {
            lastError = "Chat still passcode-locked after entry — wrong CHAT_PIN?";
            break;
          }
        }

        // Re-open the composer fresh for this attempt.
        const newChat = page.locator('[data-testid="dm-new-chat-button"]');
        if ((await newChat.count()) === 0) {
          if (await wallUp()) continue; // re-locked again — next pass recovers
          lastError = "Chat app structure changed (no new-message button) — reader needs an update.";
          break;
        }
        await newChat.click().catch(() => {});
        const searchReady = await waitUntil(page, 4000, async () =>
          (await page.locator('[data-testid="new-dm-search-input"]').count()) > 0
        );
        if (!searchReady) {
          lastError = "Chat app structure changed (no recipient search) — reader needs an update.";
          break;
        }

        if (!expected) {
          readerReached = true; // smoke mode: composer reachable = reader runs
          break;
        }

        const searchInput = page.locator('[data-testid="new-dm-search-input"]');
        await searchInput.click();
        await page.keyboard.type(expected, { delay: 80 });

        // Wait for the suggestion row WITH the expected text — the element can
        // exist before its text hydrates (observed live), and a text-less row
        // silently fails the filter below.
        const rowSel = () =>
          page.locator('[data-testid^="new-dm-user-suggestion"]').filter({ hasText: expected });
        const rowReady = await waitUntil(page, 5000, async () => (await rowSel().count()) > 0);
        if (!rowReady) {
          // No thread with this handle exists yet: honest, no match either.
          lastError = `No conversation with @${expected} exists yet.`;
          break;
        }

        const row = rowSel().first();
        // The suggestion row id carries the X USER ID — honest sender evidence.
        const rowTestId = await row.getAttribute("data-testid");
        const userIdMatch = /(\d{10,20})/.exec(rowTestId || "");
        senderUserId = userIdMatch ? userIdMatch[1] : null;

        await row.click();

        // Verify the click actually OPENED the conversation: a click landing
        // the instant a row hydrates can be swallowed — retry once.
        const threadOpenSignal = async () =>
          (await page.locator(
            '[data-testid="dm-conversation-header"], [data-testid="dm-message-request-prompt"], [data-testid^="message-text-"]'
          ).count()) > 0;
        let opened = await waitUntil(page, 3500, threadOpenSignal);
        if (!opened) {
          await row.click().catch(() => {});
          opened = await waitUntil(page, 3500, threadOpenSignal);
        }
        openSaw = openSaw || opened;
        if (!opened) continue; // retry pass

        // Message poll — aborts the instant the wall re-locks (a re-locked
        // embed shows no messages and never will).
        const trail = [];
        let got = 0;
        let relocked = false;
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(1300);
          if (await wallUp()) {
            relocked = true;
            break;
          }
          const count = await page.evaluate(() => {
            const root = document.querySelector('[data-testid="xchatEmbedRoute"]')?.shadowRoot;
            if (!root) return -1;
            return root.querySelectorAll('[data-testid^="message-text-"]').length;
          });
          trail.push(count);
          if (count > 0) {
            got = count;
            break;
          }
        }
        lastTrail = trail;
        lastEmpty = (await page.locator('[data-testid="dm-empty-conversation-state"]').count()) > 0;
        if (relocked) continue; // next pass recovers the wall and re-opens

        if (got > 0) {
          thread = await page.evaluate((codeSeed) => {
            const root = document.querySelector('[data-testid="xchatEmbedRoute"]')?.shadowRoot;
            if (!root) return null;
            const headers = [];
            for (const sel of ['[data-testid="dm-conversation-header"]', '[data-testid="dm-conversation-username"]', '[data-testid="dm-message-request-prompt"]']) {
              const el = root.querySelector(sel);
              if (el) headers.push((el.textContent || "").slice(0, 400));
            }
            const messageTexts = Array.from(root.querySelectorAll('[data-testid^="message-text-"]'))
              .slice(0, 60)
              .map((el) => (el.textContent || "").trim());
            const messageIds = Array.from(root.querySelectorAll('[data-testid^="message-"]'))
              .map((el) => (el.getAttribute("data-testid") || "").replace(/^message-text-/, "").replace(/^message-/, ""))
              .filter((id) => /^[0-9a-f-]{16,64}$/i.test(id));
            return {
              header: headers.join(" | "),
              messageTexts,
              messageIds: Array.from(new Set(messageIds)).slice(0, 30),
              knot: codeSeed,
            };
          }, wantedCodes[0]);

          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(800);

          if (thread) {
            lastRead = thread.messageTexts.length;
            break; // successful read of this conversation
          }
        }
        // got === 0 (no messages, wall never re-locked): history was slow or
        // failed — let the next pass try opening it again.
      } // passes

      if (!expected) {
        if (readerReached) continue;
        if (lastError) out.error = out.error || lastError;
        continue;
      }

      if (thread) {
        threadsRead += 1;
        // Honest observability: counts only — no message text or headers are
        // ever emitted by the reader.
        out.message_counts = [...(out.message_counts || []), { handle: expected, trail: lastTrail, read: lastRead, empty: lastEmpty }];

        // Participant truth: the caller's own texts must name the expected
        // handle (thread header or the request prompt do).
        const headerHandles = new Set(
          (thread.header.match(/@([A-Za-z0-9_]{1,15})/g) || []).map((h) => h.slice(1).toLowerCase())
        );
        if (args.expected.length && headerHandles.size && !headerHandles.has(expected)) {
          matches.push({
            handle: null,
            conversation_key: expected,
            error: `The conversation named @${expected} is actually with ${Array.from(headerHandles).map((h) => "@" + h).join(", ")}.`,
            codes: [],
          });
          continue;
        }

        const foundCodes = codeMatches(thread.messageTexts.join("\n"));
        // Case-normalise BOTH sides: the capture keeps the lowercase prefix,
        // argv codes are upper-cased whole — a raw includes() compared
        // "vyral-X" against "VYRAL-X" and never intersected.
        const hit = foundCodes.filter((c) => wantedCodes.includes(c.toUpperCase()));
        if (hit.length) {
          matches.push({
            handle: expected,
            conversation_key: expected,
            // User id from the suggestion row — recorded, never rendered.
            sender_user_id: senderUserId,
            codes: hitArray(hit),
          });
        }
      } else if (openSaw) {
        // The conversation OPENED but not one message ever rendered across
        // all passes. That is NOT a clean read — claiming "no code" here
        // would lie about an inbox we never actually saw. Retryable infra.
        threadsRead += 1;
        out.message_counts = [...(out.message_counts || []), { handle: expected, trail: lastTrail, read: 0, empty: lastEmpty }];
        couldNotRead = true;
      } else {
        // Never opened: row missing or structure broke — honest error.
        if (lastError) out.error = out.error || lastError;
      }
    }

    out.read_ok = !couldNotRead;
    out.read_conversations = threadsRead;
    out.requests_checked = true; // search dereference covers request-gated threads
    out.matches = matches.filter((m) => (m.codes || []).length > 0 && m.handle);
    out.ok = out.matches.length > 0;

    if (!out.ok) {
      const realFailure = matches.find((m) => !m.handle);
      out.error = couldNotRead
        ? "The conversation could not be read this time (the chat re-locked or messages did not load) — please try again."
        : (realFailure && realFailure.error) ||
          (threadsRead
            ? `No matching DM yet — read ${threadsRead} conversation(s) for the claimed handle${args.expected.length ? "" : ""}.`
            : (out.error || "No conversations to read yet."));
    }
    console.log(JSON.stringify(out));
  } catch (error) {
    out.error = "chat reader failed: " + (error instanceof Error ? error.message : String(error));
    console.log(JSON.stringify(out));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

function hitArray(codes) {
  return Array.from(new Set(codes));
}

await main();
