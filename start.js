/**
 * start.js — launches all three services together:
 *   1. Webhook server  (port 3001) — receives TradingView alerts
 *   2. Signal checker  — polls Yahoo Finance every 5 min, detects signals
 *   3. AI Screener     — screens AI/energy/infra universe every 30 min
 *
 * Usage: node start.js
 */
"use strict";

const { run: runScreener } = require("./enhanced_screener");
const { regenerateDashboard } = require("./dashboard_writer");

const SCREENER_INTERVAL_MIN = 30;
const SCREENER_INTERVAL_MS  = SCREENER_INTERVAL_MIN * 60 * 1000;

console.log("=== SPX Signal Monitor ===\n");

// ── SERVICE 1 & 2: Webhook server + Signal checker ────────────────────────────
require("./webhook_monitor.js");
require("./signal_checker.js");

// ── SERVICE 3: AI Screener (every 30 min, no-LLM for speed) ──────────────────

async function runScreenerCycle() {
    const ts = new Date().toLocaleString();
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  [SCREENER] Run started @ ${ts}`);
    console.log("─".repeat(60));

    try {
        const result = await runScreener({ noLLM: false, topN: 5, model: "gemma-4-e2b-it" });

        if (result?.top?.length) {
            const tickers = result.top.map((s, i) => `${i + 1}.${s.ticker}`).join("  ");
            console.log(`  [SCREENER] Top ${result.top.length} picks: ${tickers}`);
        }

        // Regenerate dashboard with updated screener results
        try {
            regenerateDashboard();
            console.log("  [SCREENER] Dashboard regenerated");
        } catch (e) {
            console.warn(`  [SCREENER] Dashboard regeneration failed: ${e.message}`);
        }

    } catch (err) {
        console.error(`  [SCREENER] Run failed: ${err.message}`);
    }

    const nextAt = new Date(Date.now() + SCREENER_INTERVAL_MS).toLocaleTimeString();
    console.log(`  [SCREENER] Next run at ${nextAt} (in ${SCREENER_INTERVAL_MIN} min)\n`);
}

// Run immediately after a short delay so signal_checker initialises first,
// then repeat every 30 minutes.
setTimeout(() => {
    runScreenerCycle();
    setInterval(runScreenerCycle, SCREENER_INTERVAL_MS);
}, 15_000);

console.log(`Screener scheduled — first run in 15s, then every ${SCREENER_INTERVAL_MIN} min\n`);
