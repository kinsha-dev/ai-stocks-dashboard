/**
 * ollama_advisor.js  --  Local LM Studio / Gemma Trade Advisor v2.0
 *
 * Packages all signal data (price, indicators, SMC, options chain,
 * 25-story news sentiment, spread recommendation) into a structured
 * prompt and sends it to a locally-running LM Studio instance.
 *
 * Default model: gemma-4-e2b-it  (load any Gemma 4 variant in LM Studio)
 * Configurable via env vars:
 *   LMS_HOST    = http://localhost:1234
 *   LMS_MODEL   = gemma-4-it       (must match the model ID shown in LM Studio)
 *   LMS_TIMEOUT = 120             (seconds to wait for response)
 *
 * Setup:
 *   1. Download & install LM Studio: https://lmstudio.ai
 *   2. Load a Gemma 4 model in LM Studio
 *   3. Start the local server (LM Studio → Local Server tab → Start Server)
 *   4. Copy the model identifier shown in LM Studio into LMS_MODEL
 *
 * The module gracefully returns null if LM Studio is not running or the
 * model is not loaded -- the rest of the signal system continues normally.
 *
 * Export: askOllama(signalData)  ->  TradeRecommendation | null
 *         checkOllamaHealth()    ->  { ok, models, hasModel }
 */

"use strict";

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── CONFIG ────────────────────────────────────────────────────────────────────

const LMS_HOST    = (process.env.LMS_HOST    || "http://localhost:1234").replace(/\/$/, "");
const LMS_MODEL   = process.env.LMS_MODEL    || "gemma-4-e2b-it";
const LMS_TIMEOUT = parseInt(process.env.LMS_TIMEOUT || "120", 10) * 1000;

// ── SKILL LOADER ──────────────────────────────────────────────────────────────

function loadTradingSkill() {
    const candidates = [
        process.env.TRADING_SKILL_FILE,
        path.join(__dirname, "SKILL.md"),
        path.join(__dirname, "..", ".claude", "skills", "trading", "SKILL.md"),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const raw = fs.readFileSync(candidate, "utf8");
            const context = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
            if (context.length > 100) {
                console.log(`  [LMS] Loaded trading methodology: ${path.basename(path.dirname(candidate))}/${path.basename(candidate)} (${context.length} chars)`);
                return context;
            }
        } catch (_) { /* try next */ }
    }
    return null;
}

const TRADING_SKILL = loadTradingSkill();

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function httpPost(host, port, pathname, body, useHttps = false) {
    const lib = useHttps ? https : http;
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: host,
            port,
            path: pathname,
            method:   "POST",
            headers:  {
                "Content-Type":   "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        };
        const req = lib.request(opts, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end",  () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on("error", reject);
        req.setTimeout(LMS_TIMEOUT, () => { req.destroy(); reject(new Error("LM Studio timeout")); });
        req.write(body);
        req.end();
    });
}

function httpGet(host, port, pathname, useHttps = false) {
    const lib = useHttps ? https : http;
    return new Promise((resolve) => {
        const req = lib.request({ hostname: host, port, path: pathname, method: "GET" }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end",  () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on("error", () => resolve({ status: 0, body: "" }));
        req.setTimeout(4000, () => { req.destroy(); resolve({ status: 0, body: "" }); });
        req.end();
    });
}

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────

/**
 * Check if LM Studio server is running and whether LMS_MODEL is loaded.
 * @returns {{ ok: boolean, models: string[], hasModel: boolean }}
 */
async function checkOllamaHealth() {
    try {
        const parsed  = new URL(LMS_HOST);
        const port    = parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 1234);
        const useSSL  = parsed.protocol === "https:";
        const resp    = await httpGet(parsed.hostname, port, "/v1/models", useSSL);
        if (resp.status !== 200) return { ok: false, models: [], hasModel: false };

        const json    = JSON.parse(resp.body);
        const models  = (json.data || []).map(m => m.id);
        const base    = LMS_MODEL.toLowerCase();
        const hasModel = models.some(m => m.toLowerCase().includes(base) || base.includes(m.toLowerCase()));
        return { ok: true, models, hasModel };
    } catch (_) {
        return { ok: false, models: [], hasModel: false };
    }
}

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────

function buildPrompt(signalData) {
    const { classic, sweep, fvg, vol, news, options, prediction, spread } = signalData;
    const sym = signalData.symbol || "NDX";
    const now = new Date().toISOString();

    const L = [];

    L.push(`You are an expert quantitative options trader specialising in ${sym}. Analyse the real-time market data below and output ONLY a JSON object — no markdown, no explanation outside the JSON.\n`);

    if (TRADING_SKILL) {
        L.push("=== TRADING SYSTEM METHODOLOGY ===");
        L.push("Use this as your grounding framework when evaluating the live data below.");
        L.push(TRADING_SKILL);
        L.push("");
    }

    L.push(`=== PRICE & INDICATORS — ${sym} (${now}) ===`);
    L.push(`Price:    $${classic.price.toFixed(2)}`);
    L.push(`EMA:      9=${classic.ema9.toFixed(2)}  21=${classic.ema21.toFixed(2)}  200=${classic.ema200.toFixed(2)}`);
    L.push(`Trend:    ${classic.bullTrend ? "BULL (above EMA200)" : "BEAR (below EMA200)"}`);
    L.push(`RSI:      ${classic.rsi.toFixed(1)}  MACD: ${classic.macd?.toFixed(2) || "n/a"}`);
    L.push(`Score:    Bull ${classic.bullScore}/3  Bear ${classic.bearScore}/3`);
    const classicSig = classic.strongBuy ? "STRONG_BUY" : classic.strongSell ? "STRONG_SELL"
                     : classic.longSignal ? "BUY" : classic.shortSignal ? "SELL" : "NONE";
    L.push(`Classic:  ${classicSig}`);
    L.push("");

    L.push("=== SMART MONEY CONCEPTS ===");
    if (sweep.bullishSweep)  L.push(`LiqSweep: BULLISH — swept $${sweep.sweptLevel?.toFixed(2)} (sell-side stops hunted, reversal UP expected)`);
    else if (sweep.bearishSweep) L.push(`LiqSweep: BEARISH — swept $${sweep.sweptLevel?.toFixed(2)} (buy-side stops hunted, reversal DOWN expected)`);
    else                     L.push(`LiqSweep: None`);
    L.push(`FVGs:     ${fvg.unfilledBull} bull / ${fvg.unfilledBear} bear (unfilled)`);
    L.push(`InFVG:    ${fvg.inBullFVG ? "BULL zone (institutional support)" : fvg.inBearFVG ? "BEAR zone (institutional resistance)" : "None"}`);
    if (fvg.nearestBullFVG) L.push(`Support:  $${fvg.nearestBullFVG.bottom.toFixed(2)}-$${fvg.nearestBullFVG.top.toFixed(2)} (bull FVG)`);
    if (fvg.nearestBearFVG) L.push(`Resist:   $${fvg.nearestBearFVG.bottom.toFixed(2)}-$${fvg.nearestBearFVG.top.toFixed(2)} (bear FVG)`);
    L.push(`Volume:   ${vol.volRatio.toFixed(2)}x avg  delta=${vol.deltaProxy.toFixed(2)}`);
    if (vol.buyingClimax)  L.push(`         *** BUYING CLIMAX — potential exhaustion top ***`);
    if (vol.sellingClimax) L.push(`         *** SELLING CLIMAX — potential exhaustion bottom ***`);
    if (vol.absorption)    L.push(`         ABSORPTION — high vol tiny body — reversal warning`);
    L.push("");

    if (options) {
        L.push(`=== OPTIONS CHAIN (${options.symbol} exp ${options.expiry} / ${options.dte} DTE) ===`);
        L.push(`Spot:     $${(options.spotPrice || classic.price).toFixed(2)}`);
        const gexSign = options.levels.posGEX ? "POSITIVE" : "NEGATIVE";
        L.push(`GEX:      ${(options.levels.totalGEX / 1e6).toFixed(1)}M [${gexSign}]`);
        L.push(`G.Pin:    $${options.levels.gammaPin}  (price magnet / highest GEX concentration)`);
        L.push(`G.Flip:   $${options.levels.gammaFlip ?? "N/A"}  (above=bull regime / below=bear regime)`);
        L.push(`CallWall: $${options.levels.callWall}  (overhead resistance)`);
        L.push(`PutWall:  $${options.levels.putWall}  (downside support)`);
        L.push(`MaxPain:  $${options.maxPain}`);
        L.push(`PCR Vol:  ${options.flow.pcrVolume}  (>1.5 contrarian bull  <0.5 contrarian bear)`);
        L.push(`PCR OI:   ${options.flow.pcrOI}`);
        if (options.flow.unusualCalls.length > 0) {
            L.push(`UnusualC: ${options.flow.unusualCalls.slice(0, 3).map(c => `$${c.strike}(${c.ratio}x)`).join(", ")}`);
        }
        if (options.flow.unusualPuts.length > 0) {
            L.push(`UnusualP: ${options.flow.unusualPuts.slice(0, 3).map(p => `$${p.strike}(${p.ratio}x)`).join(", ")}`);
        }
        L.push(`OPT Scr:  Bull ${options.score.bull} / Bear ${options.score.bear}`);
        for (const r of options.score.reasons.slice(0, 4)) L.push(`  - ${r}`);
        L.push("");
    }

    const storyCount   = news.storyCount  || news.articles?.length || 0;
    const sourceCount  = news.sourceCount || 1;
    L.push(`=== NEWS SENTIMENT (${storyCount} stories / ${sourceCount} sources) ===`);
    L.push(`Aggregate: ${news.emoji} ${news.label}  score: ${news.score}`);
    if (news.articles?.length > 0) {
        const topStories = [...news.articles]
            .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
            .slice(0, 10);
        for (const a of topStories) {
            const sign = a.score > 0 ? "+" : "";
            L.push(`  [${sign}${a.score}][${a.source || "?"}] ${a.title}`);
        }
    }
    L.push("");

    L.push("=== PREDICTION ENGINE ===");
    L.push(`Bias:     ${prediction.bias}  |  Confidence: ${prediction.confidence}%`);
    L.push(`Bull pts: ${prediction.bull}  /  Bear pts: ${prediction.bear}`);
    L.push("Factors:");
    for (const r of prediction.reasons.slice(0, 8)) L.push(`  + ${r}`);
    L.push("");

    if (spread?.recommended) {
        const rec = spread.recommended;
        L.push("=== SPREAD CALCULATOR RECOMMENDATION ===");
        L.push(`Strategy:     ${rec.strategy}  [${rec.type.toUpperCase()}]  ${rec.trendLabel || ""}`);
        L.push(`IV Regime:    ${spread.ivRegime || "N/A"}  →  ${spread.creditOrDebit || rec.type.toUpperCase()} spread selected`);
        L.push("Legs:");
        for (const leg of rec.legs) {
            const delta = leg.delta != null ? `  δ=${leg.delta}` : "";
            L.push(`  ${leg.action} ${leg.type} $${leg.strike}  IV=${leg.iv}%  θ-price=$${leg.theorPrice}${delta}`);
        }
        if (rec.type === "debit") {
            L.push(`Net Debit:    $${rec.netDebit} per share  ($${rec.maxLoss} per contract)`);
            L.push(`Max Profit:   $${rec.maxProfit} per contract`);
            L.push(`Break-even:   $${rec.breakEven ?? rec.upperBreakEven}`);
        } else {
            L.push(`Net Credit:   $${rec.netCredit} per share  ($${rec.maxProfit} per contract)`);
            L.push(`Max Loss:     $${rec.maxLoss} per contract`);
            L.push(`Profit zone:  ${rec.profitZone ?? "N/A"}`);
        }
        if (rec.targetPrice != null) {
            L.push(`TARGET PRICE: $${rec.targetPrice}  ← max profit strike`);
            if (rec.targetNote) L.push(`Target note:  ${rec.targetNote}`);
        }
        if (rec.probOfProfit != null) L.push(`Prob of Profit: ${rec.probOfProfit}%`);
        L.push(`R/R:          ${rec.riskReward}`);
        if (spread.rationale?.length) {
            L.push("Context:");
            for (const r of spread.rationale) L.push(`  * ${r}`);
        }
        L.push("");
    }

    L.push("=== REQUIRED OUTPUT ===");
    L.push("Output ONLY the following JSON — no markdown fences, no extra text:");
    L.push(`{
  "action": "BUY | SELL | HOLD | WAIT",
  "conviction": "HIGH | MEDIUM | LOW",
  "time_horizon": "intraday | swing_2_5d | weekly",
  "strategy": "specific options strategy name",
  "entry_zone": "e.g. $651-653",
  "stop_loss": "price level",
  "target": "price level",
  "spread": {
    "buy_leg":  "TYPE $strike exp MM/DD",
    "sell_leg": "TYPE $strike exp MM/DD (null if straddle)",
    "max_loss":  "$X per contract",
    "max_gain":  "$X per contract"
  },
  "reasoning": "2-3 sentences: why this trade, what drives it",
  "risks": "1-2 sentences: what could invalidate this trade",
  "key_levels": {
    "support": "$price",
    "resistance": "$price",
    "invalidation": "$price (close below/above = wrong)"
  }
}`);

    return L.join("\n");
}

// ── RESPONSE PARSER ───────────────────────────────────────────────────────────

function parseResponse(raw) {
    let cleaned = raw
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();

    try { return JSON.parse(cleaned); } catch (_) {}

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
        try { return JSON.parse(match[0]); } catch (_) {}
    }

    return {
        action:     "WAIT",
        conviction: "LOW",
        reasoning:  "Model output could not be parsed as JSON — check logs",
        raw_excerpt: raw.slice(0, 300),
    };
}

// ── MAIN ENTRY ────────────────────────────────────────────────────────────────

/**
 * Ask the local LM Studio model for a trade recommendation.
 * Returns null gracefully if LM Studio is not running or model not loaded.
 *
 * @param {object} signalData  { classic, sweep, fvg, vol, news, options, prediction, spread }
 * @returns {Promise<TradeRecommendation | null>}
 */
async function askOllama(signalData) {
    const health = await checkOllamaHealth();
    if (!health.ok) {
        console.log(`  [LMS] Not reachable at ${LMS_HOST} — skipping AI advisor`);
        console.log(`  [LMS] Start LM Studio and enable the local server (port 1234)`);
        return null;
    }
    if (!health.hasModel) {
        const avail = health.models.length ? health.models.join(", ") : "none loaded";
        console.log(`  [LMS] Model "${LMS_MODEL}" not found.  Available: ${avail}`);
        console.log(`  [LMS] Load a Gemma 4 model in LM Studio and set LMS_MODEL to its identifier`);
        return null;
    }

    console.log(`  [LMS] Querying ${LMS_MODEL} via LM Studio...`);
    const start = Date.now();

    try {
        const prompt  = buildPrompt(signalData);
        const reqBody = JSON.stringify({
            model: LMS_MODEL,
            messages: [
                { role: "user", content: prompt },
            ],
            temperature: 0.2,
            max_tokens:  512,
        });

        const parsed = new URL(LMS_HOST);
        const port   = parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 1234);
        const useSSL = parsed.protocol === "https:";
        const resp   = await httpPost(parsed.hostname, port, "/v1/chat/completions", reqBody, useSSL);

        if (resp.status !== 200) {
            console.log(`  [LMS] HTTP ${resp.status}: ${resp.body.slice(0, 100)}`);
            return null;
        }

        const obj  = JSON.parse(resp.body);
        const raw  = obj.choices?.[0]?.message?.content || "";
        const rec  = parseResponse(raw);
        const ms   = Date.now() - start;

        console.log(`  [LMS] Response in ${ms}ms — action: ${rec.action}  conviction: ${rec.conviction}`);
        return { model: LMS_MODEL, generatedMs: ms, ...rec };

    } catch (err) {
        console.log(`  [LMS] Error: ${err.message}`);
        return null;
    }
}

module.exports = { askOllama, checkOllamaHealth };
