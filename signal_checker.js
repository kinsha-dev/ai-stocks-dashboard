/**
 * signal_checker.js  --  NDX Signal Monitor  v5.0
 *
 * Polls Yahoo Finance every POLL_INTERVAL minutes.
 *
 * Data pipeline:
 *   1. NDX price + OHLCV  (Yahoo Finance v8)
 *   2. 25 news stories    (5 parallel RSS sources via news_aggregator.js)
 *   3. QQQ options chain  (GEX / gamma levels / PCR via options_checker.js)
 *   4. Spread calculator  (best spread strategy via spread_calculator.js)
 *   5. AI trade advisor   (local Ollama gemma4:latest via ollama_advisor.js)
 *
 * Classic indicators: EMA 9/21/200, RSI, MACD, volume filter
 * Smart Money Concepts: liquidity sweeps, FVGs, volume analysis
 * Prediction engine: up to 14-point composite score (+ AI overlay)
 * Push notifications via ntfy.sh (no API key required)
 *
 * No npm dependencies -- pure Node.js.
 */

"use strict";

const https = require("https");

// ── NEW MODULES ───────────────────────────────────────────────────────────────
const { analyzeOptions, analyzeOptionsFor } = require("./options_checker");
const { fetchAllNews, aggregateSentiment } = require("./news_aggregator");
const { recommendSpread }             = require("./spread_calculator");
const { askOllama }                   = require("./ollama_advisor");
const { fetchAIETFData }              = require("./ai_etf_monitor");
const { writeDashboard, writeDashboardMulti } = require("./dashboard_writer");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const NTFY_TOPIC    = process.env.NTFY_TOPIC    || "ndx-signals-kinsha";
const NTFY_SERVER   = process.env.NTFY_SERVER   || "https://ntfy.sh";
const NTFY_TOKEN    = process.env.NTFY_TOKEN    || "";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5", 10);   // minutes
const INTERVAL      = "30m";
const RANGE         = "60d";

// ── SYMBOL CONFIGS ────────────────────────────────────────────────────────────
const SYMBOLS = [
    { ticker: "^NDX",   symbol: "NDX", optionsSym: process.env.NDX_OPTIONS_SYMBOL  || "QQQ" },
    { ticker: "^GSPC",  symbol: "SPX", optionsSym: process.env.SPX_OPTIONS_SYMBOL  || "SPY" },
];

// Classic indicator params
const EMA_FAST  = 9;
const EMA_SLOW  = 21;
const EMA_TREND = 200;
const RSI_LEN   = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIG  = 9;
const RSI_OB    = 70;
const RSI_OS    = 30;
const VOL_MULT  = 1.5;

// SMC params
const SWING_LB  = 5;
const FVG_LIMIT = 5;
const SWEEP_LB  = 50;

// Dedup: don't repeat the same STRONG signal back-to-back (per symbol)
const lastSignal     = {};   // e.g. { NDX: "STRONG_BUY", SPX: null }
const lastSignalSide = {};   // e.g. { NDX: "BUY", SPX: "SELL" } — for flip detection

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — CLASSIC MATH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function ema(values, period) {
    const k = 2 / (period + 1);
    let result = new Array(values.length).fill(undefined);
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        result[i] = prev;
    }
    return result;
}

function rsi(closes, period) {
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        gains.push(diff > 0 ? diff : 0);
        losses.push(diff < 0 ? -diff : 0);
    }
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let result = new Array(period).fill(null);
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
        result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
}

function macd(closes, fast, slow, signal) {
    const emaFast  = ema(closes, fast);
    const emaSlow  = ema(closes, slow);
    const macdLine = closes.map((_, i) =>
        emaFast[i] !== undefined && emaSlow[i] !== undefined
            ? emaFast[i] - emaSlow[i] : undefined);
    const validMacd = macdLine.filter(v => v !== undefined);
    const sigEma    = ema(validMacd, signal);
    const offset    = macdLine.findIndex(v => v !== undefined);
    const sigLine   = new Array(offset + signal - 1).fill(undefined)
                        .concat(sigEma.slice(signal - 1));
    const hist = macdLine.map((v, i) =>
        v !== undefined && sigLine[i] !== undefined ? v - sigLine[i] : undefined);
    return { macdLine, sigLine, hist };
}

function sma(values, period) {
    return values.map((_, i) =>
        i < period - 1
            ? undefined
            : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
}

function crossover(a, b, i) {
    return a[i] !== undefined && b[i] !== undefined &&
           a[i - 1] !== undefined && b[i - 1] !== undefined &&
           a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossunder(a, b, i) {
    return a[i] !== undefined && b[i] !== undefined &&
           a[i - 1] !== undefined && b[i - 1] !== undefined &&
           a[i - 1] >= b[i - 1] && a[i] < b[i];
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — SMART MONEY CONCEPTS
// ─────────────────────────────────────────────────────────────────────────────

function detectSwingPoints(high, low, lookback = SWING_LB) {
    const swingHighs = [];
    const swingLows  = [];
    for (let i = lookback; i < high.length - 1; i++) {
        const leftHighs  = high.slice(i - lookback, i);
        const leftLows   = low.slice(i - lookback, i);
        const rightHighs = high.slice(i + 1, Math.min(i + lookback + 1, high.length));
        const rightLows  = low.slice(i + 1, Math.min(i + lookback + 1, low.length));
        if (high[i] > Math.max(...leftHighs) && high[i] > Math.max(...rightHighs)) swingHighs.push({ index: i, price: high[i] });
        if (low[i]  < Math.min(...leftLows)  && low[i]  < Math.min(...rightLows))  swingLows.push({ index: i, price: low[i] });
    }
    return { swingHighs, swingLows };
}

function detectLiquiditySweep(data) {
    const { high, low, close } = data;
    const i = close.length - 1;
    const sliceStart = Math.max(0, i - SWEEP_LB);
    const { swingHighs, swingLows } = detectSwingPoints(high.slice(sliceStart, i), low.slice(sliceStart, i));
    let bullishSweep = false, bearishSweep = false, sweptLevel = null, sweepType = null;
    for (const sh of swingHighs) {
        if (high[i] > sh.price && close[i] < sh.price) {
            bearishSweep = true; sweptLevel = sh.price; sweepType = "SELL-SIDE LIQUIDITY"; break;
        }
    }
    if (!bearishSweep) {
        for (const sl of swingLows) {
            if (low[i] < sl.price && close[i] > sl.price) {
                bullishSweep = true; sweptLevel = sl.price; sweepType = "BUY-SIDE LIQUIDITY"; break;
            }
        }
    }
    return { bullishSweep, bearishSweep, sweptLevel, sweepType };
}

function detectFVG(data) {
    const { high, low, close } = data;
    const i = close.length - 1;
    const currentPrice = close[i];
    const bullishFVGs = [], bearishFVGs = [];
    const scanFrom = Math.max(2, i - 100);
    for (let j = scanFrom; j <= i; j++) {
        if (low[j] > high[j - 2]) bullishFVGs.push({ index: j, top: low[j], bottom: high[j - 2], midpoint: (low[j] + high[j - 2]) / 2, filled: false });
        if (high[j] < low[j - 2]) bearishFVGs.push({ index: j, top: low[j - 2], bottom: high[j], midpoint: (low[j - 2] + high[j]) / 2, filled: false });
    }
    for (const fvg of bullishFVGs) { if (low[fvg.index + 1] !== undefined && low[fvg.index + 1] <= fvg.bottom) fvg.filled = true; }
    for (const fvg of bearishFVGs) { if (high[fvg.index + 1] !== undefined && high[fvg.index + 1] >= fvg.top) fvg.filled = true; }
    const unfilledBull = bullishFVGs.filter(f => !f.filled).slice(-FVG_LIMIT);
    const unfilledBear = bearishFVGs.filter(f => !f.filled).slice(-FVG_LIMIT);
    const inBullFVG = unfilledBull.some(f => currentPrice >= f.bottom && currentPrice <= f.top);
    const inBearFVG = unfilledBear.some(f => currentPrice >= f.bottom && currentPrice <= f.top);
    const nearestBullFVG = unfilledBull.filter(f => f.top < currentPrice).sort((a, b) => b.top - a.top)[0] || null;
    const nearestBearFVG = unfilledBear.filter(f => f.bottom > currentPrice).sort((a, b) => a.bottom - b.bottom)[0] || null;
    return { unfilledBull: unfilledBull.length, unfilledBear: unfilledBear.length, inBullFVG, inBearFVG, nearestBullFVG, nearestBearFVG };
}

function analyzeVolume(data) {
    const { open, high, low, close, volume } = data;
    const i = close.length - 1;
    const volSmaArr  = sma(volume, 20);
    const avgVol     = volSmaArr[i];
    const curVol     = volume[i];
    const range      = high[i] - low[i];
    const climax     = curVol > avgVol * 3;
    const aboveAvg   = curVol > avgVol * VOL_MULT;
    const bodySize   = Math.abs(close[i] - open[i]);
    const bodyPct    = range > 0 ? bodySize / range : 0;
    const closePos   = range > 0 ? (close[i] - low[i]) / range : 0.5;
    const deltaProxy = range > 0 ? (close[i] - open[i]) / range : 0;
    const vol5Avg    = volume.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
    return {
        currentVol: curVol, avgVol, volRatio: avgVol > 0 ? curVol / avgVol : 1,
        aboveAvg, climax, buyingClimax: climax && closePos > 0.7,
        sellingClimax: climax && closePos < 0.3,
        absorption: aboveAvg && bodyPct < 0.2,
        deltaProxy, volumeRising: curVol > vol5Avg, closePosition: closePos,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — NEXT-CANDLE PREDICTION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function predictNextCandle(classic, sweep, fvg, vol, news, options = null) {
    let bull = 0, bear = 0;
    const reasons = [];

    // Classic EMA trend (+2)
    if (classic.bullTrend) { bull += 2; reasons.push("price > EMA200"); }
    else                    { bear += 2; reasons.push("price < EMA200"); }

    // EMA crossover (+1)
    if (classic.emaCrossUp)   { bull += 1; reasons.push("EMA9 crossed UP"); }
    if (classic.emaCrossDown) { bear += 1; reasons.push("EMA9 crossed DOWN"); }

    // RSI (+1)
    if (classic.rsiBull) { bull += 1; reasons.push(`RSI ${classic.rsi.toFixed(1)} bull zone`); }
    if (classic.rsiBear) { bear += 1; reasons.push(`RSI ${classic.rsi.toFixed(1)} bear zone`); }

    // MACD crossover (+1)
    if (classic.macdCrossUp)   { bull += 1; reasons.push("MACD crossed UP"); }
    if (classic.macdCrossDown) { bear += 1; reasons.push("MACD crossed DOWN"); }

    // Liquidity sweep (+1)
    if (sweep.bullishSweep) { bull += 1; reasons.push(`Bullish sweep at ${sweep.sweptLevel?.toFixed(2)}`); }
    if (sweep.bearishSweep) { bear += 1; reasons.push(`Bearish sweep at ${sweep.sweptLevel?.toFixed(2)}`); }

    // FVG (+1)
    if (fvg.inBullFVG) { bull += 1; reasons.push("Price in bull FVG (support zone)"); }
    if (fvg.inBearFVG) { bear += 1; reasons.push("Price in bear FVG (resistance zone)"); }
    if (!fvg.inBullFVG && !fvg.inBearFVG) {
        if (fvg.nearestBullFVG && Math.abs(classic.price - fvg.nearestBullFVG.top) / classic.price < 0.005) { bull += 1; reasons.push("Near bull FVG support"); }
        if (fvg.nearestBearFVG && Math.abs(classic.price - fvg.nearestBearFVG.bottom) / classic.price < 0.005) { bear += 1; reasons.push("Near bear FVG resistance"); }
    }

    // Volume (+1)
    if (vol.buyingClimax)  { bull += 1; reasons.push("Buying climax (exhaustion → potential reversal up)"); }
    if (vol.sellingClimax) { bear += 1; reasons.push("Selling climax (exhaustion → potential reversal down)"); }
    if (!vol.buyingClimax && !vol.sellingClimax) {
        if (vol.deltaProxy > 0.5 && vol.aboveAvg)  { bull += 1; reasons.push("Strong bull volume delta"); }
        if (vol.deltaProxy < -0.5 && vol.aboveAvg) { bear += 1; reasons.push("Strong bear volume delta"); }
    }

    // News sentiment (max +2)
    if      (news.score >= 1.5)  { bull += 2; reasons.push(`News STRONGLY bullish (${news.storyCount || news.articles?.length || 0} stories)`); }
    else if (news.score >= 0.5)  { bull += 1; reasons.push("News mildly bullish"); }
    else if (news.score <= -1.5) { bear += 2; reasons.push(`News STRONGLY bearish (${news.storyCount || news.articles?.length || 0} stories)`); }
    else if (news.score <= -0.5) { bear += 1; reasons.push("News mildly bearish"); }

    // Options chain signals (max +4 per direction)
    if (options) {
        bull += options.score.bull;
        bear += options.score.bear;
        for (const r of options.score.reasons) reasons.push(`OPT: ${r}`);
    }

    const maxScore   = options ? 14 : 10;
    const net        = bull - bear;
    const bias       = net > 1 ? "BULL" : net < -1 ? "BEAR" : "NEUTRAL";
    const dominant   = Math.max(bull, bear);
    const confidence = Math.round((dominant / maxScore) * 100);

    return { bull, bear, bias, confidence, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — DATA FETCHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV history for any Yahoo Finance ticker.
 * @param {string} ticker  e.g. "^NDX", "^GSPC"
 */
function fetchTicker(ticker) {
    return new Promise((resolve, reject) => {
        const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${INTERVAL}&range=${RANGE}`;
        const req  = https.request(
            { hostname: "query1.finance.yahoo.com", path, method: "GET", headers: { "User-Agent": "Mozilla/5.0" } },
            (res) => {
                let raw = "";
                res.on("data", c => raw += c);
                res.on("end", () => {
                    try {
                        const json   = JSON.parse(raw);
                        const result = json.chart.result;
                        if (!result) throw new Error(JSON.stringify(json.chart.error));
                        const quotes = result[0].indicators.quote[0];
                        const rawClose = quotes.close;
                        const last  = rawClose.reduceRight((acc, v, i) => acc === -1 && v !== null ? i : acc, -1);
                        const n     = last + 1;
                        const fill  = (arr) => {
                            const out = arr.slice(0, n).map(v => (v === null || v === undefined) ? 0 : v);
                            let prev = out[0];
                            return out.map(v => { if (v === 0 && prev) return prev; prev = v; return v; });
                        };
                        resolve({ timestamps: result[0].timestamp.slice(0, n), open: fill(quotes.open), high: fill(quotes.high), low: fill(quotes.low), close: fill(quotes.close), volume: fill(quotes.volume) });
                    } catch (e) { reject(new Error("Yahoo parse: " + e.message)); }
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("Yahoo timeout")); });
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — CLASSIC SIGNAL COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

function computeClassicSignals(data) {
    const { close, volume } = data;
    const ema9   = ema(close, EMA_FAST);
    const ema21  = ema(close, EMA_SLOW);
    const ema200 = ema(close, EMA_TREND);
    const rsiArr = rsi(close, RSI_LEN);
    const { macdLine, sigLine, hist } = macd(close, MACD_FAST, MACD_SLOW, MACD_SIG);
    const volSma = sma(volume, 20);
    const i = close.length - 1;
    const bullTrend    = close[i] > ema200[i];
    const bearTrend    = close[i] < ema200[i];
    const rsiVal       = rsiArr[i];
    const rsiBull      = rsiVal > 50 && rsiVal < RSI_OB;
    const rsiBear      = rsiVal < 50 && rsiVal > RSI_OS;
    const macdBull     = macdLine[i] > 0 && hist[i] > 0;
    const macdBear     = macdLine[i] < 0 && hist[i] < 0;
    const volOk        = volume[i] > volSma[i] * VOL_MULT;
    const emaCrossUp   = crossover(ema9, ema21, i);
    const emaCrossDown = crossunder(ema9, ema21, i);
    const macdCrossUp  = crossover(macdLine, sigLine, i);
    const macdCrossDown= crossunder(macdLine, sigLine, i);
    const bullScore    = (ema9[i] > ema21[i] ? 1 : 0) + (macdBull ? 1 : 0) + (rsiBull ? 1 : 0);
    const bearScore    = (ema9[i] < ema21[i] ? 1 : 0) + (macdBear ? 1 : 0) + (rsiVal < 50 ? 1 : 0);
    const longSignal   = emaCrossUp   && bullTrend && rsiBull && macdCrossUp   && volOk;
    const shortSignal  = emaCrossDown && bearTrend && rsiBear && macdCrossDown && volOk;
    const strongBuy    = longSignal  && bullScore >= 3;
    const strongSell   = shortSignal && bearScore >= 3;
    return { price: close[i], rsi: rsiVal, bullScore, bearScore, longSignal, shortSignal, strongBuy, strongSell, bullTrend, bearTrend, rsiBull, rsiBear, emaCrossUp, emaCrossDown, macdCrossUp, macdCrossDown, ema9: ema9[i], ema21: ema21[i], ema200: ema200[i], macd: macdLine[i] };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5.5 — COMPOSITE SIGNAL HELPER (runs per symbol)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full signal pipeline for one symbol's price data + options.
 * News sentiment is shared across symbols (market-wide).
 */
function computeAllSignals(data, optionsData, news) {
    const classic    = computeClassicSignals(data);
    const sweep      = detectLiquiditySweep(data);
    const fvg        = detectFVG(data);
    const vol        = analyzeVolume(data);
    const prediction = predictNextCandle(classic, sweep, fvg, vol, news, optionsData);
    return { classic, sweep, fvg, vol, prediction };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

function signalSide(sig) {
    if (!sig) return null;
    if (sig.includes("BUY") || sig.includes("BULL")) return "BUY";
    if (sig.includes("SELL") || sig.includes("BEAR")) return "SELL";
    return null;
}

function buildFlipPayload(sym, prevSide, newSide, classic, prediction, aiRec) {
    const arrow   = `${prevSide} → ${newSide}`;
    const emoji   = newSide === "BUY" ? "📈" : "📉";
    let message   = `$${classic.price.toFixed(2)} | RSI ${classic.rsi.toFixed(1)} | Bias ${prediction.bias} ${prediction.confidence}%\n`;
    message      += `Flipped from ${prevSide} to ${newSide}`;
    if (aiRec) {
        message += `\nAI: ${aiRec.action} (${aiRec.conviction})`;
        if (aiRec.reasoning) message += ` — ${aiRec.reasoning.slice(0, 100)}`;
    }
    return {
        title:    `🔄${emoji} ${sym} SIGNAL FLIP: ${arrow}`,
        message:  message.trim(),
        priority: 5,
        tags:     [newSide === "BUY" ? "chart_increasing" : "chart_decreasing", "rotating_light"],
    };
}

function buildPushPayload(symbol, action, classic, smcSummary, prediction, news, options, spread, aiRec) {
    const emojiMap  = { STRONG_BUY: "🚀", STRONG_SELL: "🔴", PREDICTION: "🔮" };
    const prioMap   = { STRONG_BUY: 5,    STRONG_SELL: 5,    PREDICTION: 3  };
    const price     = classic.price.toLocaleString("en-US", { minimumFractionDigits: 2 });
    const score     = action.includes("BUY") ? classic.bullScore : classic.bearScore;

    let message = `$${price} | RSI: ${classic.rsi.toFixed(1)} | Score: ${score}/3\n`;
    message    += `SMC: ${smcSummary}\n`;
    message    += `Bias: ${prediction.bias} ${prediction.confidence}% | Stories: ${news.storyCount || news.articles?.length || 0} from ${news.sourceCount || 1} srcs\n`;

    // Options levels
    if (options) {
        const gexM = (options.levels.totalGEX / 1e6).toFixed(1);
        message += `GEX: ${gexM}M ${options.levels.posGEX ? "[+]" : "[-]"} | PCR: ${options.flow.pcrVolume} | Pin: $${options.levels.gammaPin}\n`;
        message += `Flip: $${options.levels.gammaFlip ?? "N/A"} | CWall: $${options.levels.callWall} | PWall: $${options.levels.putWall}\n`;
    }

    // Spread recommendation
    if (spread?.recommended) {
        const rec = spread.recommended;
        message += `\nSpread: ${rec.strategy}\n`;
        for (const leg of rec.legs) {
            message += `  ${leg.action} ${leg.type} $${leg.strike} (IV:${leg.iv}% $${leg.theorPrice})\n`;
        }
        const pl = rec.type === "debit"
            ? `Debit $${rec.netDebit} | Max Profit $${rec.maxProfit} | Max Loss $${rec.maxLoss}`
            : `Credit $${rec.netCredit} | Max Profit $${rec.maxProfit} | Max Loss $${rec.maxLoss}`;
        message += `  ${pl}\n`;
    }

    // AI recommendation
    if (aiRec) {
        const convEmoji = aiRec.conviction === "HIGH" ? "🤖🔥" : aiRec.conviction === "MEDIUM" ? "🤖" : "🤖❓";
        message += `\n${convEmoji} AI: ${aiRec.action} (${aiRec.conviction}) ${aiRec.time_horizon || ""}\n`;
        if (aiRec.reasoning) message += `  ${aiRec.reasoning.slice(0, 120)}\n`;
    }

    // Top 3 news
    if (news.articles?.length > 0) {
        const top3 = [...news.articles].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);
        message += `\nNews: ${news.emoji} ${news.label} (${news.score})\n`;
        for (const a of top3) {
            message += `  ${a.score >= 0 ? "+" : ""}${a.score} ${a.title.substring(0, 50)}\n`;
        }
    }

    // Title: if AI agrees with signal, use higher-priority title
    let title = `${emojiMap[action] || "📊"} ${symbol} ${action.replace(/_/g, " ")}`;
    if (aiRec?.action === "BUY"  && action.includes("BUY"))  title = `🚀🤖 ${symbol} STRONG BUY (AI CONFIRMED)`;
    if (aiRec?.action === "SELL" && action.includes("SELL")) title = `🔴🤖 ${symbol} STRONG SELL (AI CONFIRMED)`;

    return {
        title,
        message: message.trim(),
        priority: prioMap[action] || 3,
        tags: [action.includes("BUY") ? "chart_increasing" : "chart_decreasing"],
    };
}

function sendPush(payload) {
    const body    = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (NTFY_TOKEN) headers["Authorization"] = `Bearer ${NTFY_TOKEN}`;
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: "ntfy.sh", path: `/${NTFY_TOPIC}`, method: "POST", headers },
            (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { console.log(`  Push -> ntfy.sh/${NTFY_TOPIC} [${res.statusCode}]`); resolve(d); }); }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — MAIN POLL LOOP
// ─────────────────────────────────────────────────────────────────────────────

// ── CONSOLE REPORT HELPER ─────────────────────────────────────────────────────
function printSymbolReport(label, classic, sweep, fvg, vol, optionsData, prediction, spreadData, aiRec) {
    console.log(`\n  [${label}] PRICE $${classic.price.toFixed(2)} | RSI ${classic.rsi.toFixed(1)} | MACD ${classic.macd?.toFixed(2)}`);
    console.log(`  [${label}] EMAs  9:${classic.ema9.toFixed(1)} / 21:${classic.ema21.toFixed(1)} / 200:${classic.ema200.toFixed(1)}`);
    console.log(`  [${label}] Trend ${classic.bullTrend ? "BULL" : "BEAR"} | Score Bull:${classic.bullScore}/3 Bear:${classic.bearScore}/3`);

    if (sweep.bullishSweep)      console.log(`  [${label}] Sweep BULLISH $${sweep.sweptLevel?.toFixed(2)}`);
    else if (sweep.bearishSweep) console.log(`  [${label}] Sweep BEARISH $${sweep.sweptLevel?.toFixed(2)}`);
    console.log(`  [${label}] FVG   Bull:${fvg.unfilledBull} Bear:${fvg.unfilledBear} | in:${fvg.inBullFVG?"BULL":fvg.inBearFVG?"BEAR":"none"}`);
    console.log(`  [${label}] Vol   x${vol.volRatio.toFixed(2)} ${vol.buyingClimax?"BUY CLIMAX":vol.sellingClimax?"SELL CLIMAX":""}`);

    if (optionsData) {
        const o    = optionsData;
        const gexM = (o.levels.totalGEX / 1e6).toFixed(1);
        console.log(`  [${label}] OPT   ${o.symbol} ${o.expiry}/${o.dte}DTE  GEX:${gexM}M[${o.levels.posGEX?"+":"-"}]`);
        console.log(`  [${label}]       Pin:$${o.levels.gammaPin} Flip:$${o.levels.gammaFlip??"N/A"} CW:$${o.levels.callWall} PW:$${o.levels.putWall} MP:$${o.maxPain}`);
    }

    console.log(`  [${label}] PRED  ${prediction.bias} ${prediction.confidence}%  Bull:${prediction.bull} Bear:${prediction.bear}`);

    if (spreadData?.recommended) {
        const rec = spreadData.recommended;
        console.log(`  [${label}] SPRD  ${rec.strategy} [${rec.type}]  ${rec.type==="debit"?`debit $${rec.netDebit}`:`credit $${rec.netCredit}`}  R/R ${rec.riskReward}`);
    }

    if (aiRec) {
        console.log(`  [${label}] AI    ${aiRec.action} (${aiRec.conviction}) ${aiRec.time_horizon||""}`);
    }
}

async function check() {
    const ts = new Date().toISOString();
    console.log(`\n${"=".repeat(62)}`);
    console.log(`[${ts}] NDX + SPX Dual Signal Check`);
    console.log("=".repeat(62));

    try {
        // ── STEP 1: PARALLEL DATA FETCH ──────────────────────────────────────
        // Fetch NDX price + SPX price + 25-story news + both options chains
        const [ndxData, spxData, rawArticles, ndxOptions, spxOptions] = await Promise.all([
            fetchTicker("^NDX"),
            fetchTicker("^GSPC"),
            fetchAllNews(),
            analyzeOptionsFor("QQQ", 0).catch(e => { console.warn(`  [WARN] QQQ Options: ${e.message}`); return null; }),
            analyzeOptionsFor("SPY", 0).catch(e => { console.warn(`  [WARN] SPY Options: ${e.message}`); return null; }),
        ]);

        // ── STEP 2: COMPUTE SIGNALS ───────────────────────────────────────────
        // News is market-wide — shared between NDX and SPX
        const news = aggregateSentiment(rawArticles);
        console.log(`\n  -- NEWS SENTIMENT (${news.storyCount} stories / ${news.sourceCount} sources) --`);
        console.log(`  Aggregate: ${news.emoji} ${news.label} (score: ${news.score})`);
        if (news.articles.length > 0) {
            const bySource = {};
            for (const a of news.articles) { if (!bySource[a.source]) bySource[a.source] = []; bySource[a.source].push(a); }
            for (const [src, arts] of Object.entries(bySource)) {
                console.log(`  [${src}]`);
                for (const a of arts) console.log(`    [${a.score>=1?"+":a.score<=-1?"-":"~"}${Math.abs(a.score)}] ${a.title}`);
            }
        }

        const ndxSig = computeAllSignals(ndxData, ndxOptions, news);
        const spxSig = computeAllSignals(spxData, spxOptions, news);

        // ── STEP 3: SPREAD RECOMMENDATIONS ───────────────────────────────────
        const ndxSpread = recommendSpread(ndxOptions, ndxSig.prediction);
        const spxSpread = recommendSpread(spxOptions, spxSig.prediction);

        // ── STEP 4: AI TRADE ADVISORS + ETF MONITOR (parallel) ───────────────
        const [ndxAI, spxAI] = await Promise.all([
            askOllama({ symbol: "NDX", ...ndxSig, news, options: ndxOptions, spread: ndxSpread })
                .catch(e => { console.warn(`  [WARN] Ollama NDX: ${e.message}`); return null; }),
            askOllama({ symbol: "SPX", ...spxSig, news, options: spxOptions, spread: spxSpread })
                .catch(e => { console.warn(`  [WARN] Ollama SPX: ${e.message}`); return null; }),
            fetchAIETFData()
                .catch(e => { console.warn(`  [WARN] AI ETF: ${e.message}`); }),
        ]);

        // ── CONSOLE REPORT ────────────────────────────────────────────────────
        printSymbolReport("NDX", ndxSig.classic, ndxSig.sweep, ndxSig.fvg, ndxSig.vol, ndxOptions, ndxSig.prediction, ndxSpread, ndxAI);
        printSymbolReport("SPX", spxSig.classic, spxSig.sweep, spxSig.fvg, spxSig.vol, spxOptions, spxSig.prediction, spxSpread, spxAI);

        // ── SIGNAL ACTIONS (per symbol) ───────────────────────────────────────
        for (const [sym, sig, opts, spread, aiRec] of [
            ["NDX", ndxSig, ndxOptions, ndxSpread, ndxAI],
            ["SPX", spxSig, spxOptions, spxSpread, spxAI],
        ]) {
            const { classic, sweep, fvg, vol, prediction } = sig;
            let action = null;
            if (classic.strongBuy)  action = "STRONG_BUY";
            if (classic.strongSell) action = "STRONG_SELL";

            // Determine effective signal direction (classic or SMC) for flip detection
            const effectiveAction = action ||
                (prediction.confidence >= 70 && prediction.bias !== "NEUTRAL"
                    ? (prediction.bias === "BULL" ? "SMC_BULL_SETUP" : "SMC_BEAR_SETUP")
                    : null);
            const newSide  = signalSide(effectiveAction);
            const prevSide = lastSignalSide[sym];
            if (prevSide && newSide && prevSide !== newSide) {
                console.log(`\n  *** [${sym}] SIGNAL FLIP: ${prevSide} → ${newSide} ***`);
                await sendPush(buildFlipPayload(sym, prevSide, newSide, classic, prediction, aiRec));
            }
            if (newSide) lastSignalSide[sym] = newSide;

            const smcSummary = [
                sweep.bullishSweep ? "BullSweep" : sweep.bearishSweep ? "BearSweep" : "",
                fvg.inBullFVG ? "InBullFVG" : fvg.inBearFVG ? "InBearFVG" : "",
                vol.climax ? `VolClimax(${vol.buyingClimax ? "buy" : "sell"})` : "",
            ].filter(Boolean).join(" | ") || "No SMC trigger";

            if (action) {
                console.log(`\n  *** [${sym}] ${action} SIGNAL ***`);
                if (action === lastSignal[sym]) {
                    console.log(`  [SKIP] Same signal as last bar`);
                } else {
                    const payload = buildPushPayload(sym, action, classic, smcSummary, prediction, news, opts, spread, aiRec);
                    await sendPush(payload);
                    lastSignal[sym] = action;
                }
            } else {
                console.log(`\n  [${sym}] No strong classic signal`);
                if (prediction.confidence >= 70 && prediction.bias !== "NEUTRAL") {
                    const biasAction = prediction.bias === "BULL" ? "SMC_BULL_SETUP" : "SMC_BEAR_SETUP";
                    console.log(`  [${sym}] SMC opportunity: ${biasAction} (${prediction.confidence}%)`);
                    const payload = buildPushPayload(sym, biasAction, classic, smcSummary, prediction, news, opts, spread, aiRec);
                    payload.priority = 4;
                    payload.title    = `🔮 ${sym} ${prediction.bias} SETUP ${prediction.confidence}%${aiRec ? ` | AI: ${aiRec.action}` : ""}`;
                    await sendPush(payload);
                } else {
                    console.log(`  [${sym}] Bias: ${prediction.bias} @ ${prediction.confidence}% (threshold: 70%)`);
                    lastSignal[sym] = null;
                }
            }
        }

        // ── STEP 5: UPDATE DASHBOARD (both symbols) ───────────────────────────
        writeDashboardMulti({
            NDX: { ...ndxSig, news, options: ndxOptions, spread: ndxSpread, ai: ndxAI },
            SPX: { ...spxSig, news, options: spxOptions, spread: spxSpread, ai: spxAI },
        });

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        if (process.env.DEBUG) console.error(err.stack);
    }
}

// Run immediately, then every POLL_INTERVAL minutes
check();
setInterval(check, POLL_INTERVAL * 60 * 1000);
const symList = SYMBOLS.map(s => `${s.symbol}(${s.ticker})`).join(" + ");
console.log(`\nSignal checker v5 started — ${symList} — polling every ${POLL_INTERVAL} min`);
console.log(`Features: EMA/RSI/MACD + SMC + 25-story news (5 sources) + Options GEX + Spread Calculator + AI (LM Studio ${process.env.LMS_MODEL || "gemma-4-e2b-it"})`);
console.log(`Push topic: https://ntfy.sh/${NTFY_TOPIC}\n`);
