/**
 * ai_etf_monitor.js  —  AI Sector ETF Monitor v1.0
 *
 * Tracks AI/semiconductor ETFs, upcoming earnings for major AI names,
 * and computes overall AI sector sentiment.
 *
 * ETFs: BOTZ, AIQ, SOXX, SMH, ARKQ, IRBO, QTUM
 * Earnings watch: NVDA, MSFT, GOOGL, META, TSLA, AMD, AVGO, AMZN, INTC, SMCI
 *
 * Output: ai_etf_data.json  (read by dashboard_writer.js)
 * Export: fetchAIETFData()
 */

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const AI_ETF_FILE = path.join(__dirname, "ai_etf_data.json");

const AI_ETFS = [
    { ticker: "BOTZ", name: "Global X Robotics & AI",    theme: "AI/Robotics"    },
    { ticker: "AIQ",  name: "Global X AI & Technology",  theme: "AI/Tech"        },
    { ticker: "SOXX", name: "iShares Semiconductor",      theme: "Semiconductors" },
    { ticker: "SMH",  name: "VanEck Semiconductor",       theme: "Semiconductors" },
    { ticker: "ARKQ", name: "ARK Autonomous Technology",  theme: "Autonomous/AI"  },
    { ticker: "IRBO", name: "iShares Robotics & AI",      theme: "Robotics/AI"    },
    { ticker: "QTUM", name: "Defiance Quantum ETF",       theme: "Quantum/AI"     },
];

const EARNINGS_WATCH = ["NVDA", "MSFT", "GOOGL", "META", "TSLA", "AMD", "AVGO", "AMZN", "INTC", "SMCI"];

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function yahooGet(urlPath) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: "query1.finance.yahoo.com", path: urlPath, method: "GET",
              headers: { "User-Agent": "Mozilla/5.0" } },
            (res) => {
                let raw = "";
                res.on("data", c => raw += c);
                res.on("end", () => resolve(raw));
            }
        );
        req.on("error", reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
    });
}

// ── ETF DATA FETCHER ──────────────────────────────────────────────────────────

async function fetchETFChart(ticker) {
    const raw    = await yahooGet(`/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=15d`);
    const json   = JSON.parse(raw);
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(`No chart data for ${ticker}`);
    return result;
}

function computeMetrics(ticker, name, theme, chartResult) {
    const q      = chartResult.indicators.quote[0];
    const pairs  = (q.close || []).map((v, i) => ({ c: v, vol: q.volume?.[i] ?? 0 })).filter(x => x.c != null);
    if (pairs.length < 2) throw new Error("Insufficient data");

    const n     = pairs.length;
    const price = pairs[n - 1].c;
    const dayChg  = ((price - pairs[n - 2].c) / pairs[n - 2].c) * 100;
    const weekChg = n >= 5 ? ((price - pairs[n - 5].c) / pairs[n - 5].c) * 100 : null;

    // RSI (up to 14 periods)
    const period = Math.min(14, n - 1);
    let gains = 0, losses = 0;
    for (let i = n - period; i < n; i++) {
        const diff = pairs[i].c - pairs[i - 1].c;
        if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgG = gains / period;
    const avgL = losses / period;
    const rsi  = parseFloat((avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)).toFixed(1));

    // EMA20 trend (uses all available closes up to 20)
    const win = Math.min(20, n);
    const k   = 2 / (win + 1);
    let ema = pairs.slice(0, win).reduce((s, p) => s + p.c, 0) / win;
    for (let i = win; i < n; i++) ema = pairs[i].c * k + ema * (1 - k);

    // Volume ratio (today vs 5-day avg)
    const recentVols = pairs.slice(-5).map(p => p.vol);
    const avgVol = recentVols.slice(0, -1).reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length - 1);
    const volRatio = avgVol > 0 ? parseFloat((recentVols[recentVols.length - 1] / avgVol).toFixed(2)) : 1;

    return {
        ticker,
        name,
        theme,
        price:    parseFloat(price.toFixed(2)),
        dayChg:   parseFloat(dayChg.toFixed(2)),
        weekChg:  weekChg != null ? parseFloat(weekChg.toFixed(2)) : null,
        rsi,
        trend:    price > ema ? "BULL" : "BEAR",
        volRatio,
        history:  pairs.slice(-5).map(p => parseFloat(p.c.toFixed(2))),
    };
}

// ── EARNINGS FETCHER ──────────────────────────────────────────────────────────

async function fetchEarnings(ticker) {
    try {
        const raw  = await yahooGet(`/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents`);
        const json = JSON.parse(raw);
        const cal  = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
        if (!cal?.earningsDate?.length) return null;
        const next   = cal.earningsDate[0];
        const date   = next.fmt || new Date(next.raw * 1000).toISOString().slice(0, 10);
        const epsEst = cal.earningsAverage?.fmt || null;
        const epsLow = cal.earningsLow?.fmt     || null;
        const epsHigh= cal.earningsHigh?.fmt    || null;
        return { ticker, date, epsEst, epsLow, epsHigh };
    } catch (_) { return null; }
}

// ── SECTOR SENTIMENT ──────────────────────────────────────────────────────────

function sectorSentiment(etfs) {
    const valid = etfs.filter(e => e.dayChg != null);
    if (!valid.length) return { label: "N/A", emoji: "❓", score: 0, avgDayChg: 0, bullCount: 0, bearCount: 0, bullTrend: 0, total: 0 };

    const avgDayChg  = valid.reduce((s, e) => s + e.dayChg, 0) / valid.length;
    const bullCount  = valid.filter(e => e.dayChg > 0).length;
    const bearCount  = valid.length - bullCount;
    const bullTrend  = valid.filter(e => e.trend === "BULL").length;
    const majority   = Math.ceil(valid.length * 0.7);

    let label, emoji, score;
    if      (avgDayChg > 1.0  && bullCount >= majority) { label = "Strongly Bullish"; emoji = "🚀"; score =  2; }
    else if (avgDayChg > 0.2  && bullCount > bearCount) { label = "Bullish";          emoji = "📈"; score =  1; }
    else if (avgDayChg < -1.0 && bearCount >= majority) { label = "Strongly Bearish"; emoji = "🔴"; score = -2; }
    else if (avgDayChg < -0.2 && bearCount > bullCount) { label = "Bearish";          emoji = "📉"; score = -1; }
    else                                                 { label = "Neutral";          emoji = "⚖️"; score =  0; }

    return { label, emoji, score,
             avgDayChg: parseFloat(avgDayChg.toFixed(2)),
             bullCount, bearCount, bullTrend, total: valid.length };
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

async function fetchAIETFData() {
    console.log("  [ETF] Fetching AI ETF data...");

    const etfResults = await Promise.allSettled(
        AI_ETFS.map(({ ticker, name, theme }) =>
            fetchETFChart(ticker).then(r => computeMetrics(ticker, name, theme, r))
        )
    );

    const etfs = etfResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`  [ETF] ${AI_ETFS[i].ticker}: ${r.reason?.message || "failed"}`);
        return { ticker: AI_ETFS[i].ticker, name: AI_ETFS[i].name, theme: AI_ETFS[i].theme,
                 price: null, dayChg: null, weekChg: null, rsi: null, trend: null,
                 volRatio: null, history: [], error: true };
    });

    const earningsRaw = await Promise.allSettled(EARNINGS_WATCH.map(t => fetchEarnings(t)));
    const today = new Date().toISOString().slice(0, 10);
    const earnings = earningsRaw
        .filter(r => r.status === "fulfilled" && r.value)
        .map(r => r.value)
        .filter(e => e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 12);

    const data = {
        timestamp: new Date().toISOString(),
        etfs,
        earnings,
        sentiment: sectorSentiment(etfs),
    };

    try {
        fs.writeFileSync(AI_ETF_FILE, JSON.stringify(data, null, 2), "utf8");
        console.log(`  [ETF] ${etfs.length} ETFs, ${earnings.length} upcoming earnings`);
    } catch (e) {
        console.warn(`  [ETF] Write failed: ${e.message}`);
    }

    return data;
}

module.exports = { fetchAIETFData, AI_ETF_FILE };
