/**
 * enhanced_screener.js  —  AI Stock Evaluator v1.0
 *
 * Layers on top of ai_screener.js:
 *   1. Risk Safety Guards  — hard pre-filters (penny stocks, weekly loss, market cap)
 *   2. Growth Amplifier    — bonus scoring for multi-timeframe momentum + fundamentals
 *   3. Local LLM Brief     — qualitative 3-sentence verdict via LM Studio
 *
 * Usage:
 *   node enhanced_screener.js              → screen + LLM, write enhanced_results.json
 *   node enhanced_screener.js --no-llm     → skip LLM (fast mode)
 *   node enhanced_screener.js --top 10     → show top 10 instead of 5
 *   node enhanced_screener.js --model <id> → use a different LM Studio model
 *
 * Requires:
 *   - ai_screener.js (same directory)
 *   - yf_fetch.py + my_trading_env/ venv (same directory)
 *   - LM Studio running locally with server enabled (optional — degrades gracefully)
 */

"use strict";

const https      = require("https");
const http       = require("http");
const fs         = require("fs");
const path       = require("path");
const { spawnSync } = require("child_process");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Edit these to tune the screener to your risk tolerance.

const RISK_GUARDS = {
    MIN_PRICE:        5,       // Penny stock floor — below this = too risky/illiquid
    MAX_WEEKLY_LOSS: -0.15,    // -15% in one week = hard distribution signal, wait it out
    MIN_MARKET_CAP_B: 0.30,   // $300M minimum — ensures institutional participation
    MIN_AVG_VOLUME:   300_000, // 300K shares/day — needed to exit cleanly
};

const GROWTH_WEIGHTS = {
    revenueGrowthOver20:  8,   // Revenue growing > 20% YoY
    positiveEarnings:     5,   // Earnings growth > 0
    allTimeframesGreen:   7,   // 1M + 3M + 6M all positive
    r1yOver100pct:        5,   // 1-year return > 100%
    r3mOver50pct:         4,   // 3-month return > 50%
    rsiGoldenZone:        5,   // RSI 45–65 (trending, not overbought)
    notOverextended:      3,   // Price within 20% of EMA50 (no chasing)
    lowBeta:              3,   // Beta < 2.0 (volatility under control)
    recentUpgrades:       3,   // More upgrades than downgrades in 30 days
};

const LLM_MODEL = process.env.LMS_MODEL || "gemma-4-e2b-it"; // Match the model ID shown in LM Studio
const LMS_HOST  = (process.env.LMS_HOST || "http://127.0.0.1:1234").replace(/\/$/, "");
const _lmsUrl   = new URL(LMS_HOST);
const LMS_HOSTNAME = _lmsUrl.hostname;
const LMS_PORT     = parseInt(_lmsUrl.port) || 1234;
const TOP_N       = 5;                 // How many top picks to return

const OUT_FILE = path.join(__dirname, "enhanced_results.json");

// ─── CLI ARGS (only used when run directly — ignored when required as a module) ─
function parseCLI() {
    const args = process.argv.slice(2);
    return {
        noLLM:    args.includes("--no-llm"),
        topN:     (() => { const i = args.indexOf("--top");   return i >= 0 ? (parseInt(args[i+1]) || TOP_N) : TOP_N; })(),
        model:    (() => { const i = args.indexOf("--model"); return i >= 0 ? (args[i+1] || LLM_MODEL) : LLM_MODEL; })(),
    };
}

// ─── IMPORT BASE SCREENER ──────────────────────────────────────────────────────
// We reuse ai_screener's stock universe, Python path, and data fetcher rather than
// duplicating them — keeping this file focused on the enhancement layer only.
const baseScreener = require("./ai_screener.js");

// Pull the constants we need directly from ai_screener.js's module scope.
// (They are module-level consts; we access them by re-reading the file here
//  since ai_screener doesn't export them. We re-declare them below.)
const PYTHON    = path.join(__dirname, "my_trading_env", "bin", "python3.12");
const PY_SCRIPT = path.join(__dirname, "yf_fetch.py");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtPct(n) { return n == null ? "—" : (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%"; }
function bar(char, n) { return char.repeat(Math.max(0, Math.min(40, Math.round(n / 2.5)))); }

// ─── RISK SAFETY GUARD ────────────────────────────────────────────────────────

/**
 * Returns null if the stock passes all guards, or a reason string if it fails.
 * Checks run cheapest-first so we short-circuit early.
 */
function applyRiskGuards(analysis) {
    const { price, perf, analyst } = analysis;

    if (price < RISK_GUARDS.MIN_PRICE) {
        return `price $${price.toFixed(2)} < $${RISK_GUARDS.MIN_PRICE} penny threshold`;
    }

    if (perf.r1w < RISK_GUARDS.MAX_WEEKLY_LOSS) {
        return `1W return ${fmtPct(perf.r1w)} exceeds ${fmtPct(RISK_GUARDS.MAX_WEEKLY_LOSS)} weekly loss guard`;
    }

    const capB = analyst?.marketCapB ?? 0;
    if (capB > 0 && capB < RISK_GUARDS.MIN_MARKET_CAP_B) {
        return `market cap $${capB.toFixed(2)}B < $${RISK_GUARDS.MIN_MARKET_CAP_B}B minimum`;
    }

    // Volume check: we don't have avg volume in the analysis object directly —
    // it's embedded in tech.volRatio. We reconstruct approx from volRatio if available.
    // (If unavailable we skip rather than wrongly filter.)
    // A volRatio check of < 0.1 effectively catches dead tickers.
    const volRatio = analysis.tech?.volRatio ?? 1;
    if (volRatio < 0.05) {
        return `volume ratio ${volRatio.toFixed(2)}x — effectively illiquid`;
    }

    // Monthly momentum gate — must have at least one month with +25% gain.
    // Filters to high-momentum names only; removes slow-movers from the pool.
    if ((perf.r1m ?? 0) < 0.25) {
        return `1M return ${fmtPct(perf.r1m)} < +25% monthly momentum required`;
    }

    return null; // ✅ passes all guards
}

// ─── GROWTH SCORING AMPLIFIER ─────────────────────────────────────────────────

/**
 * Adds bonus points on top of the base score from ai_screener.js's scoreStock().
 * The maximum possible bonus is 43 pts; the composite is capped at 100.
 */
function growthBonus(analysis) {
    const { perf, analyst, tech } = analysis;
    let bonus = 0;
    const bonusLog = [];

    // Fundamental growth
    if ((analyst.revenueGrowthPct ?? 0) > 20) {
        bonus += GROWTH_WEIGHTS.revenueGrowthOver20;
        bonusLog.push(`📈 Rev growth ${analyst.revenueGrowthPct?.toFixed(0)}% (>${20}%)`);
    }
    if ((analyst.earningsGrowthPct ?? 0) > 0) {
        bonus += GROWTH_WEIGHTS.positiveEarnings;
        bonusLog.push(`💰 Positive earnings growth`);
    }

    // Multi-timeframe momentum — all three green = trend confirmation
    if (perf.r1m > 0 && perf.r3m > 0 && perf.r6m > 0) {
        bonus += GROWTH_WEIGHTS.allTimeframesGreen;
        bonusLog.push(`🟢 1M/3M/6M all positive`);
    }

    // Exceptional return thresholds
    if (perf.r1y > 1.0) {   // > 100% in a year
        bonus += GROWTH_WEIGHTS.r1yOver100pct;
        bonusLog.push(`🚀 1Y return ${fmtPct(perf.r1y)}`);
    }
    if (perf.r3m > 0.5) {   // > 50% in 3 months
        bonus += GROWTH_WEIGHTS.r3mOver50pct;
        bonusLog.push(`⚡ 3M return ${fmtPct(perf.r3m)}`);
    }

    // RSI golden zone: trending but not overbought
    const rsi = tech.rsi ?? 50;
    if (rsi >= 45 && rsi <= 65) {
        bonus += GROWTH_WEIGHTS.rsiGoldenZone;
        bonusLog.push(`📊 RSI ${rsi.toFixed(0)} in golden zone 45–65`);
    }

    // Price not overextended vs EMA50 (avoid chasing)
    const price = analysis.price;
    const e50   = tech.e50 ?? price;
    if (e50 > 0 && (price - e50) / e50 < 0.20) {
        bonus += GROWTH_WEIGHTS.notOverextended;
        bonusLog.push(`✅ Price within 20% of EMA50 (not extended)`);
    }

    // Controlled volatility
    if ((analyst.beta ?? 1) < 2.0) {
        bonus += GROWTH_WEIGHTS.lowBeta;
        bonusLog.push(`🛡️ Beta ${analyst.beta?.toFixed(1)} < 2.0`);
    }

    // Fresh analyst support
    if ((analyst.upgrades ?? 0) > (analyst.downgrades ?? 0) && analyst.upgrades > 0) {
        bonus += GROWTH_WEIGHTS.recentUpgrades;
        bonusLog.push(`⭐ ${analyst.upgrades} upgrade${analyst.upgrades > 1 ? "s" : ""} vs ${analyst.downgrades} downgrade${analyst.downgrades !== 1 ? "s" : ""} (30d)`);
    }

    return { bonus: Math.round(bonus), bonusLog };
}

// ─── LOCAL LLM (OLLAMA) ───────────────────────────────────────────────────────

function checkOllama() {
    return new Promise(resolve => {
        const req = http.get({
            hostname: LMS_HOSTNAME, port: LMS_PORT, path: "/v1/models", timeout: 3000,
        }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
    });
}

function buildLLMPrompt(stock) {
    const { ticker, name, price, dayChg, perf, tech, analyst, news, flash } = stock;
    const headline = news?.topStory?.title ?? "(no recent news)";
    const recLabel = analyst.recMean <= 1.5 ? "Strong Buy"
                   : analyst.recMean <= 2.0 ? "Buy"
                   : analyst.recMean <= 2.5 ? "Moderate Buy"
                   : analyst.recMean <= 3.0 ? "Hold" : "Sell";

    return `You are a concise equity analyst specialising in high-growth AI and tech stocks. \
Analyse ${ticker} (${name}) using these metrics and respond in EXACTLY 3 sentences:

PRICE DATA:
  Current price: $${price.toFixed(2)} | Day change: ${dayChg >= 0 ? "+" : ""}${dayChg.toFixed(2)}%
  Returns: 1W ${fmtPct(perf.r1w)} | 1M ${fmtPct(perf.r1m)} | 3M ${fmtPct(perf.r3m)} | 1Y ${fmtPct(perf.r1y)}

TECHNICALS:
  RSI: ${tech.rsi?.toFixed(0)} | MACD: ${tech.macdBull ? "Bullish" : "Bearish"}
  Above EMA200: ${tech.aboveEma200 ? "Yes" : "No"} | Golden Cross: ${tech.ema50AboveEma200 ? "Yes" : "No"}
  Volume ratio: ${tech.volRatio?.toFixed(1)}x average

FUNDAMENTALS:
  Analyst consensus: ${recLabel} (${analyst.recMean?.toFixed(2)}/5 from ${analyst.numAnalysts} analysts)
  Price target: $${analyst.targetMean > 0 ? analyst.targetMean.toFixed(0) : "—"} (${analyst.upsidePct >= 0 ? "+" : ""}${analyst.upsidePct?.toFixed(0)}% upside)
  Revenue growth: ${analyst.revenueGrowthPct >= 0 ? "+" : ""}${analyst.revenueGrowthPct?.toFixed(0)}% | Earnings growth: ${analyst.earningsGrowthPct >= 0 ? "+" : ""}${analyst.earningsGrowthPct?.toFixed(0)}%
  Beta: ${analyst.beta?.toFixed(1)} | Market cap: $${analyst.marketCapB?.toFixed(1)}B

RECENT NEWS: "${headline}"
FLASH SIGNALS: ${flash.length ? flash.join(", ") : "none"}

Respond in EXACTLY 3 sentences (no lists, no bullet points):
Sentence 1: Why this stock looks compelling right now (cite 2 specific metrics).
Sentence 2: The single biggest risk an investor should monitor.
Sentence 3: Your verdict — start with exactly one of: STRONG BUY / BUY / HOLD / AVOID — then one clause explaining why.`;
}

function askOllama(prompt, model) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens:  200,
        });
        const req = http.request({
            hostname: LMS_HOSTNAME,
            port:     LMS_PORT,
            path:     "/v1/chat/completions",
            method:   "POST",
            headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString());
                    resolve({ ok: true, text: (json.choices?.[0]?.message?.content || "").trim() });
                } catch (_) {
                    resolve({ ok: false, text: "" });
                }
            });
        });
        req.setTimeout(60_000, () => { req.destroy(); resolve({ ok: false, text: "timeout" }); });
        req.on("error", e => resolve({ ok: false, text: e.message }));
        req.write(body);
        req.end();
    });
}

/** Extract the VERDICT keyword from the LLM's 3rd sentence. */
function extractVerdict(text) {
    const t = text.toUpperCase();
    if (t.includes("STRONG BUY")) return "STRONG BUY";
    if (t.includes("AVOID"))      return "AVOID";
    if (t.includes("BUY"))        return "BUY";
    if (t.includes("HOLD"))       return "HOLD";
    return "—";
}

// ─── DATA FETCH (reuses yf_fetch.py via venv) ──────────────────────────────────

function fetchData(tickers) {
    if (!fs.existsSync(PY_SCRIPT)) {
        console.error(`❌  yf_fetch.py not found at ${PY_SCRIPT}`);
        return {};
    }
    const pre = spawnSync(PYTHON, ["-c", "import yfinance; print('ok')"], { timeout: 8_000, encoding: "buffer" });
    if (pre.error || pre.status !== 0) {
        console.error(`❌  venv python not available at ${PYTHON}`);
        console.error(`    Fix: cd outputs && python3 -m venv my_trading_env && my_trading_env/bin/pip install yfinance`);
        return {};
    }
    console.log(`  [YF] Fetching ${tickers.length} tickers via venv python…`);
    const result = spawnSync(PYTHON, [PY_SCRIPT, ...tickers], {
        timeout: 420_000, maxBuffer: 60_000_000, encoding: "buffer",
    });
    if (result.error || result.status !== 0) {
        const err = result.stderr?.toString("utf8")?.slice(-300) || result.error?.message || "";
        console.error(`❌  yf_fetch.py failed: ${err}`);
        return {};
    }
    if (result.stderr) process.stdout.write(result.stderr.toString("utf8"));
    try { return JSON.parse(result.stdout.toString("utf8")); } catch (_) { return {}; }
}

// ─── TECHNICAL HELPERS (mirrors ai_screener.js — kept local to avoid tight coupling) ──

function calcEMA(arr, n) {
    const k = 2 / (n + 1); let ema = null;
    return arr.map(v => { if (v == null) return null; ema = ema == null ? v : v * k + ema * (1 - k); return ema; });
}
function calcRSI(closes, n = 14) {
    const res = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return res;
    let ag = 0, al = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i-1]; if (d >= 0) ag += d; else al -= d; }
    ag /= n; al /= n;
    res[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i-1];
        ag = (ag * (n-1) + Math.max(d, 0)) / n;
        al = (al * (n-1) + Math.max(-d, 0)) / n;
        res[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return res;
}
function calcMACD(closes) {
    const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
    const ml  = closes.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
    const valid = ml.filter(v => v != null);
    const sg9 = calcEMA(valid, 9); const sl = new Array(closes.length).fill(null); let j = 0;
    ml.forEach((v, i) => { if (v != null) sl[i] = sg9[j++]; });
    return { bull: ml.map((v, i) => v != null && sl[i] != null ? v > sl[i] : false) };
}
function calcReturn(closes, bars) {
    const last = closes[closes.length - 1]; const start = closes[Math.max(0, closes.length - 1 - bars)];
    return (start && start > 0) ? (last - start) / start : 0;
}

const BULL_KW = ["beat","surge","record","wins","contract","upgrade","billion","milestone","rally"];
const BEAR_KW = ["miss","drops","decline","cut","downgrade","loss","lawsuit","fraud","investigation"];
function scoreHeadline(title) {
    const t = title.toLowerCase(); let s = 0;
    for (const w of BULL_KW) if (t.includes(w)) s++;
    for (const w of BEAR_KW) if (t.includes(w)) s--;
    return Math.max(-3, Math.min(3, s));
}

function buildAnalysis(stock, d) {
    const closes  = (d.ohlcv?.closes  || []).filter(v => v != null && isFinite(v));
    const volumes = (d.ohlcv?.volumes || []).filter(v => v != null && isFinite(v));
    if (closes.length < 60) return null;
    const len = closes.length;

    const ema9  = calcEMA(closes, 9);  const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50); const ema200 = calcEMA(closes, 200);
    const rsiArr = calcRSI(closes, 14);
    const macd   = calcMACD(closes);

    const last = closes[len-1];
    const e9   = ema9[len-1]   ?? last;
    const e21  = ema21[len-1]  ?? last;
    const e50  = ema50[len-1]  ?? last;
    const e200 = ema200[len-1] ?? last;
    const rsi  = rsiArr[len-1] ?? 50;

    const vol20  = volumes.slice(-20);
    const avgVol = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 1;
    const volRat = volumes.length ? (volumes[volumes.length-1] || 0) / avgVol : 1;

    const a = d.analyst || {};
    const newsItems = (d.news || []).map(n => ({ ...n, sentiment: scoreHeadline(n.title) }));
    const topStory  = newsItems.find(n => Math.abs(n.sentiment) >= 1) || newsItems[0] || null;

    const dayChg = a.dayChangePct ?? 0;
    const r1w = calcReturn(closes, 5); const r1m = calcReturn(closes, 21);
    const r3m = calcReturn(closes, 63); const r6m = calcReturn(closes, 126);
    const r1y = calcReturn(closes, 252);

    const flash = [];
    if (dayChg >=  5) flash.push(`⚡ +${dayChg.toFixed(1)}% today`);
    if (dayChg <= -5) flash.push(`⚠️ ${dayChg.toFixed(1)}% today`);
    if ((a.upgrades ?? 0) > (a.downgrades ?? 0) && a.upgrades > 0)
        flash.push(`🔼 ${a.upgrades} upgrade${a.upgrades > 1 ? "s" : ""} (30d)`);
    if ((a.upsidePct ?? 0) >= 30) flash.push(`🎯 +${a.upsidePct?.toFixed(0)}% to target`);
    if (r1w >= 0.08) flash.push(`🚀 +${(r1w*100).toFixed(1)}% this week`);

    return {
        ticker: stock.ticker, name: stock.name, sector: stock.sector,
        price: parseFloat(last.toFixed(2)), dayChg,
        tech: {
            rsi, e9, e21, e50, e200, volRatio: volRat,
            aboveEma200:      last > e200,
            ema50AboveEma200: e50 > e200,
            ema9AboveEma21:   e9 > e21,
            macdBull:         macd.bull[len-1],
            rsiHealthy:       rsi >= 45 && rsi <= 72,
        },
        perf: { r1w, r1m, r3m, r6m, r1y },
        analyst: {
            recMean:          a.recommendationMean ?? 3,
            recKey:           a.recommendationKey ?? "hold",
            upsidePct:        a.upsidePct ?? 0,
            targetMean:       a.targetMean ?? 0,
            numAnalysts:      a.numberOfAnalysts ?? 0,
            upgrades:         a.upgrades ?? 0,
            downgrades:       a.downgrades ?? 0,
            revenueGrowthPct: (a.revenueGrowth ?? 0) * 100,
            earningsGrowthPct:(a.earningsGrowth ?? 0) * 100,
            grossMarginsPct:  (a.grossMargins ?? 0) * 100,
            beta:             a.beta ?? 1,
            marketCapB:       (a.marketCap ?? 0) / 1e9,
        },
        news: { topStory, items: newsItems.slice(0, 5) },
        flash,
    };
}

// ─── BASE SCORE (simple version mirroring ai_screener's logic) ──────────────

function baseScore(analysis) {
    const { tech, perf, analyst, news } = analysis;
    let score = 0;
    if (tech.aboveEma200)       score += 10;
    if (tech.ema50AboveEma200)  score += 4;
    if (tech.ema9AboveEma21)    score += 5;
    if (tech.macdBull)          score += 6;
    if (tech.rsiHealthy)        score += 5;
    if (tech.volRatio >= 1.3)   score += 2;
    // Analyst
    const rm = analyst.recMean;
    if      (rm <= 1.5) score += 15;
    else if (rm <= 2.0) score += 12;
    else if (rm <= 2.5) score += 8;
    else if (rm <= 3.0) score += 3;
    const up = analyst.upsidePct;
    if      (up >= 30)  score += 7;
    else if (up >= 15)  score += 4;
    else if (up >= 5)   score += 2;
    if (analyst.upgrades > analyst.downgrades && analyst.upgrades > 0) score += 3;
    // News sentiment
    const newsAvg = news.items.length
        ? news.items.reduce((s, n) => s + (n.sentiment || 0), 0) / news.items.length : 0;
    if      (newsAvg >= 1.5) score += 10;
    else if (newsAvg >= 0.5) score += 6;
    else if (newsAvg >= 0)   score += 2;
    // Performance (simplified percentile — within this batch, not full universe rank)
    if (perf.r1m > 0.05)  score += 5;
    if (perf.r3m > 0.10)  score += 6;
    if (perf.r6m > 0.15)  score += 6;
    if (analysis.flash.length) score += Math.min(5, analysis.flash.length * 2);
    return Math.min(60, Math.round(score)); // cap base at 60; bonus adds up to 43
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

/**
 * run(opts) — callable both as a CLI and as an imported module function.
 *
 * @param {object} opts
 * @param {boolean} [opts.noLLM=false]          - skip Ollama analysis
 * @param {number}  [opts.topN=5]               - how many top picks to return
 * @param {string}  [opts.model=LLM_MODEL]      - Ollama model name
 * @returns {Promise<object|null>}              - the output object written to JSON, or null on hard error
 */
async function run(opts = {}) {
    const noLLM   = opts.noLLM  ?? false;
    const topN    = opts.topN   ?? TOP_N;
    const llmModel = opts.model ?? LLM_MODEL;

    const LINE  = "─".repeat(64);
    const DLINE = "═".repeat(64);
    console.log(`\n${DLINE}`);
    console.log(`  🛡️  ENHANCED AI STOCK EVALUATOR  —  ${new Date().toLocaleString()}`);
    console.log(DLINE);

    // 1. Load AI_STOCKS from ai_screener (we just require it to get the list)
    //    The module exports runScreener but we only need the stock universe.
    //    We read AI_STOCKS by re-importing the module's internal list via a trick:
    //    ai_screener.js defines AI_STOCKS as a module-level const. We extract it
    //    by running a tiny node eval that requires the file.
    let AI_STOCKS;
    try {
        // Extract AI_STOCKS array from ai_screener.js without running its main logic
        const src = fs.readFileSync(path.join(__dirname, "ai_screener.js"), "utf8");
        const match = src.match(/const AI_STOCKS\s*=\s*(\[[\s\S]*?\]);/);
        if (!match) throw new Error("Could not locate AI_STOCKS array");
        AI_STOCKS = eval(match[1]); // safe — it's a static array literal we wrote
    } catch (e) {
        console.error(`❌  Could not load AI_STOCKS from ai_screener.js: ${e.message}`);
        process.exit(1);
    }

    console.log(`  📋  Universe: ${AI_STOCKS.length} stocks (small/mid cap AI only)\n`);

    // 2. Fetch all data
    const tickers = AI_STOCKS.map(s => s.ticker);
    const rawData = fetchData(tickers);
    if (Object.keys(rawData).length === 0) { throw new Error("No data returned from yf_fetch.py — check venv and network"); }

    // 3. Build analysis objects
    const analyses = [];
    const missingData = [];
    for (const stock of AI_STOCKS) {
        const d = rawData[stock.ticker];
        if (!d || d.error || !d.ohlcv?.closes?.length) { missingData.push(stock.ticker); continue; }
        const a = buildAnalysis(stock, d);
        if (a) analyses.push(a);
        else missingData.push(stock.ticker);
    }
    if (missingData.length) console.log(`  [WARN] No data for: ${missingData.join(", ")}\n`);

    // 4. Risk Safety Guards — pre-filter pass
    console.log(`${LINE}`);
    console.log(`  🛡️  RISK SAFETY GUARDS`);
    console.log(LINE);
    const filtered_out = [];
    const passed = [];

    for (const a of analyses) {
        const reason = applyRiskGuards(a);
        if (reason) {
            filtered_out.push({ ticker: a.ticker, name: a.name, price: a.price, reason });
            console.log(`  ✗  ${a.ticker.padEnd(6)}  $${String(a.price.toFixed(2)).padStart(7)}  ⛔ ${reason}`);
        } else {
            passed.push(a);
        }
    }

    console.log(`\n  Passed: ${passed.length} / ${analyses.length}  |  Filtered: ${filtered_out.length}\n`);

    if (passed.length === 0) {
        console.log(`  ❌  No stocks passed the risk guards. Loosen RISK_GUARDS thresholds to continue.\n`);
        return { top: [], filteredOut: filtered_out, passedGuards: 0 };
    }

    // 5. Score — base + growth bonus
    console.log(LINE);
    console.log(`  📊  SCORING (base + growth bonus)`);
    console.log(LINE);

    const scored = passed.map(a => {
        const base = baseScore(a);
        const { bonus, bonusLog } = growthBonus(a);
        const finalScore = Math.min(100, base + bonus);
        return { ...a, baseScore: base, growthBonus: bonus, bonusLog, finalScore };
    }).sort((a, b) => b.finalScore - a.finalScore);

    // 6. Top N picks
    const topPicks = scored.slice(0, topN);

    console.log(`\n  🏆  TOP ${topN} PICKS:\n`);
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    topPicks.forEach((s, i) => {
        console.log(`  ${medals[i]}  ${s.ticker.padEnd(6)}  $${s.price.toFixed(2).padStart(8)}  Score: ${s.finalScore}/100  (base ${s.baseScore} + bonus ${s.growthBonus})`);
        console.log(`        ${s.name} · ${s.sector}`);
        if (s.bonusLog.length) console.log(`        ${s.bonusLog.join("  ")}`);
        if (s.flash.length)    console.log(`        ${s.flash.join("  ")}`);
        console.log();
    });

    // 7. Local LLM analysis
    const llmResults = {};

    if (!noLLM) {
        console.log(LINE);
        console.log(`  🤖  LOCAL LLM ANALYSIS  (${llmModel} via LM Studio)`);
        console.log(LINE);

        const ollamaUp = await checkOllama();
        if (!ollamaUp) {
            console.log(`  ⚠️  LM Studio not reachable at ${LMS_HOST}`);
            console.log(`       Start LM Studio, load a Gemma 4 model, and enable the local server`);
            console.log(`       Set LMS_MODEL env var to match the model identifier in LM Studio`);
            console.log(`       Or skip:    node enhanced_screener.js --no-llm\n`);
        } else {
            console.log(`  ✅  LM Studio reachable — using model: ${llmModel}\n`);

            for (const [i, stock] of topPicks.entries()) {
                process.stdout.write(`  [${i+1}/${topPicks.length}] Asking LLM about ${stock.ticker}… `);
                const prompt = buildLLMPrompt(stock);
                const { ok, text } = await askOllama(prompt, llmModel);

                if (!ok || !text) {
                    console.log(`⚠️  no response`);
                    llmResults[stock.ticker] = { verdict: "—", brief: "", error: text || "no response" };
                    continue;
                }

                const verdict = extractVerdict(text);
                llmResults[stock.ticker] = { verdict, brief: text };
                console.log(`✅  ${verdict}`);

                // Print the brief inline
                const lines = text.split(/(?<=[.!?])\s+/);
                lines.forEach(l => console.log(`       ${l}`));
                console.log();
            }
        }
    } else {
        console.log(`\n  ℹ️  LLM skipped (--no-llm flag)\n`);
    }

    // 8. Build output JSON
    const ts = new Date().toISOString();
    const output = {
        timestamp:  ts,
        universe:   AI_STOCKS.length,
        analyzed:   analyses.length,
        passedGuards: passed.length,
        filteredOut: filtered_out,
        riskGuards: RISK_GUARDS,
        top: topPicks.map(s => ({
            rank:        topPicks.indexOf(s) + 1,
            ticker:      s.ticker,
            name:        s.name,
            sector:      s.sector,
            price:       s.price,
            dayChg:      parseFloat(s.dayChg.toFixed(2)),
            baseScore:   s.baseScore,
            growthBonus: s.growthBonus,
            finalScore:  s.finalScore,
            bonusLog:    s.bonusLog,
            flash:       s.flash,
            perf: {
                r1w: parseFloat((s.perf.r1w * 100).toFixed(2)),
                r1m: parseFloat((s.perf.r1m * 100).toFixed(1)),
                r3m: parseFloat((s.perf.r3m * 100).toFixed(1)),
                r6m: parseFloat((s.perf.r6m * 100).toFixed(1)),
                r1y: parseFloat((s.perf.r1y * 100).toFixed(1)),
            },
            analyst: {
                consensus:      s.analyst.recKey,
                recMean:        parseFloat(s.analyst.recMean.toFixed(2)),
                targetMean:     s.analyst.targetMean,
                upsidePct:      parseFloat(s.analyst.upsidePct.toFixed(1)),
                revenueGrowth:  parseFloat(s.analyst.revenueGrowthPct.toFixed(1)),
                earningsGrowth: parseFloat(s.analyst.earningsGrowthPct.toFixed(1)),
                beta:           parseFloat((s.analyst.beta || 1).toFixed(2)),
                marketCapB:     parseFloat(s.analyst.marketCapB.toFixed(2)),
            },
            llm: llmResults[s.ticker] ?? { verdict: "skipped", brief: "" },
            topStory: s.news.topStory ? { title: s.news.topStory.title, url: s.news.topStory.url || null } : null,
        })),
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), "utf8");

    // 8b. Also write screener_results.json in the format dashboard_writer.js expects
    //     so the AI Top Picks section in dashboard.html updates with risk-filtered picks.
    const SCREENER_FILE = path.join(__dirname, "screener_results.json");
    const screenerCompat = {
        timestamp: ts,
        analyzed:  passed.length,
        top5: topPicks.slice(0, 5).map(s => ({
            ticker:     s.ticker,
            name:       s.name,
            sector:     s.sector,
            price:      s.price,
            dayChg:     parseFloat(s.dayChg.toFixed(2)),
            score:      s.finalScore,          // enhanced score (base + growth bonus)
            consensus:  s.analyst.recKey,
            recMean:    parseFloat(s.analyst.recMean.toFixed(2)),
            targetMean: s.analyst.targetMean,
            upsidePct:  parseFloat(s.analyst.upsidePct.toFixed(1)),
            perf: {
                r1m: parseFloat((s.perf.r1m * 100).toFixed(1)),
                r3m: parseFloat((s.perf.r3m * 100).toFixed(1)),
                r1y: parseFloat((s.perf.r1y * 100).toFixed(1)),
            },
            signals: s.bonusLog,               // growth bonus reasons → signals column
            flash:   s.flash,
            topStory: s.news.topStory
                ? { title: s.news.topStory.title, url: s.news.topStory.url || null }
                : null,
        })),
    };
    fs.writeFileSync(SCREENER_FILE, JSON.stringify(screenerCompat, null, 2), "utf8");

    // 9. Summary table
    console.log(`${DLINE}`);
    console.log(`  📋  FINAL SUMMARY — ${topN} PICKS AFTER RISK FILTERING`);
    console.log(DLINE);
    console.log(`  ${"RANK".padEnd(5)} ${"TICKER".padEnd(7)} ${"PRICE".padStart(8)} ${"SCORE".padStart(6)} ${"1W".padStart(7)} ${"1M".padStart(7)} ${"3M".padStart(7)} ${"LLM VERDICT".padStart(13)}`);
    console.log(`  ${"-".repeat(68)}`);
    topPicks.forEach((s, i) => {
        const llm = llmResults[s.ticker]?.verdict ?? "—";
        const row = [
            `${medals[i]} ${String(i+1).padEnd(2)}`,
            s.ticker.padEnd(6),
            `$${s.price.toFixed(2)}`.padStart(8),
            `${s.finalScore}/100`.padStart(7),
            fmtPct(s.perf.r1w).padStart(7),
            fmtPct(s.perf.r1m).padStart(7),
            fmtPct(s.perf.r3m).padStart(7),
            llm.padStart(13),
        ];
        console.log(`  ${row.join("  ")}`);
    });

    if (filtered_out.length) {
        console.log(`\n  ⛔  ${filtered_out.length} stocks filtered by risk guards:`);
        filtered_out.forEach(f => console.log(`       ${f.ticker.padEnd(6)} — ${f.reason}`));
    }

    console.log(`\n  Results saved → ${OUT_FILE}`);
    console.log(`  Dashboard sync  → ${SCREENER_FILE}`);
    console.log(`${DLINE}\n`);

    return output;
}

// ─── ENTRY POINT & EXPORT ─────────────────────────────────────────────────────

if (require.main === module) {
    // Running directly: node enhanced_screener.js [flags]
    const opts = parseCLI();
    run(opts).catch(err => {
        console.error("\n❌  Enhanced screener failed:", err.message);
        process.exit(1);
    });
}

module.exports = { run, RISK_GUARDS, GROWTH_WEIGHTS };
