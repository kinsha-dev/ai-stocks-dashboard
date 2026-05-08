/**
 * start_screener.js — Enhanced AI Screener Runner v2.0
 *
 * Runs enhanced_screener.js (risk guards + growth scoring + local LLM) on a
 * repeating schedule, then regenerates dashboard.html after each run so the
 * AI Top Picks section updates immediately.
 *
 * What changed from v1:
 *   - Now calls enhanced_screener (risk guards + growth bonus) instead of ai_screener
 *   - Passes --no-llm, --model, --top flags through to the enhanced screener
 *   - Writes both enhanced_results.json AND screener_results.json (dashboard compat)
 *   - Shows a clean run summary with filter stats + LLM verdicts
 *   - --interval flag to set a custom repeat interval (default 24h)
 *
 * Usage:
 *   node start_screener.js                    # run now + repeat every 24h with LLM
 *   node start_screener.js --no-llm           # skip LLM (faster, same risk guards)
 *   node start_screener.js --model mistral:7b # use a different Ollama model
 *   node start_screener.js --top 10           # show top 10 picks
 *   node start_screener.js --interval 12      # repeat every 12 hours instead of 24
 *   node start_screener.js --once             # run once and exit (no repeat)
 *   pm2 start start_screener.js               # run as background daemon
 *
 * To stop:  Ctrl+C  or  pm2 stop start_screener
 */

"use strict";

const { run: runEnhanced } = require("./enhanced_screener");
const { regenerateDashboard } = require("./dashboard_writer");

// ─── CLI PARSING ──────────────────────────────────────────────────────────────

function parseCLI() {
    const args = process.argv.slice(2);
    const get  = (flag, fallback) => {
        const i = args.indexOf(flag);
        return i >= 0 ? args[i + 1] : fallback;
    };
    return {
        noLLM:    args.includes("--no-llm"),
        once:     args.includes("--once"),
        topN:     parseInt(get("--top",      "5"),  10) || 5,
        model:    get("--model", "gemma3:latest"),
        interval: parseInt(get("--interval", "24"), 10) || 24,
    };
}

// ─── FORMATTING HELPERS ───────────────────────────────────────────────────────

function fmtDuration(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function banner(title) {
    const LINE = "═".repeat(64);
    console.log(`\n${LINE}`);
    console.log(`  ${title}`);
    console.log(LINE);
}

function printRunSummary(result, elapsed) {
    if (!result) { console.log("  ⚠️  Run returned no result."); return; }

    const { top = [], filteredOut = [], passedGuards = 0, analyzed = 0 } = result;

    console.log(`\n  ✅  Run complete in ${fmtDuration(elapsed)}`);
    console.log(`      Universe: ${result.universe ?? "?"} stocks → analyzed: ${analyzed} → passed guards: ${passedGuards} → filtered: ${filteredOut.length}`);

    if (top.length === 0) {
        console.log("      No picks returned.");
        return;
    }

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    console.log(`\n  🏆  TOP ${top.length} PICKS (risk-filtered + enhanced scoring):`);
    top.forEach((s, i) => {
        const verdict = s.llm?.verdict ?? "—";
        const verdictBadge = verdict === "STRONG BUY" ? "🚀 STRONG BUY"
                           : verdict === "BUY"         ? "✅ BUY"
                           : verdict === "HOLD"        ? "⏸️ HOLD"
                           : verdict === "AVOID"       ? "⛔ AVOID" : `— ${verdict}`;
        console.log(`  ${medals[i] ?? (i+1+".")}  ${s.ticker.padEnd(6)}  Score ${s.finalScore}/100  ${verdictBadge}`);
    });

    if (filteredOut.length) {
        console.log(`\n  ⛔  Filtered by risk guards (${filteredOut.length} stocks):`);
        filteredOut.slice(0, 8).forEach(f =>
            console.log(`       ${f.ticker.padEnd(6)} — ${f.reason}`)
        );
        if (filteredOut.length > 8) console.log(`       … and ${filteredOut.length - 8} more`);
    }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function loop() {
    const opts = parseCLI();
    const INTERVAL_MS = opts.interval * 60 * 60 * 1000;

    banner(`🛡️  AI SCREENER RUNNER  —  started ${new Date().toLocaleString()}`);
    console.log(`  Mode:     ${opts.noLLM ? "Fast (no LLM)" : `LLM-assisted (${opts.model})`}`);
    console.log(`  Top N:    ${opts.topN} picks`);
    console.log(`  Interval: ${opts.once ? "once only" : `every ${opts.interval}h`}`);
    console.log(`  Filters:  penny stocks < $5 | weekly loss > -5% | mkt cap < $300M`);

    let runCount = 0;

    while (true) {
        runCount++;
        banner(`🔄  RUN #${runCount}  —  ${new Date().toLocaleString()}`);
        const t0 = Date.now();

        let result = null;
        try {
            // ── 1. Run the enhanced screener (risk guards + growth bonus + LLM) ──
            result = await runEnhanced({
                noLLM: opts.noLLM,
                topN:  opts.topN,
                model: opts.model,
            });

            // ── 2. Regenerate dashboard.html with the updated screener_results.json ──
            try {
                regenerateDashboard();
                console.log("  📊  Dashboard regenerated → dashboard.html");
            } catch (dashErr) {
                console.warn(`  ⚠️  Dashboard regeneration failed: ${dashErr.message}`);
            }

        } catch (err) {
            console.error(`\n  ❌  Run #${runCount} failed: ${err.message}`);
            if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
        }

        printRunSummary(result, Date.now() - t0);

        if (opts.once) {
            console.log("\n  --once flag set — exiting after single run.\n");
            break;
        }

        // ── Schedule next run ─────────────────────────────────────────────────
        const nextAt = new Date(Date.now() + INTERVAL_MS);
        console.log(`\n  ⏰  Next run: ${nextAt.toLocaleString()}  (in ${opts.interval}h)\n`);

        // Tick every minute so the process stays responsive to Ctrl+C
        const endTime = Date.now() + INTERVAL_MS;
        while (Date.now() < endTime) {
            const remaining = endTime - Date.now();
            await new Promise(r => setTimeout(r, Math.min(60_000, remaining)));
        }
    }
}

loop().catch(err => {
    console.error("\n❌  Screener runner crashed:", err.message);
    process.exit(1);
});
