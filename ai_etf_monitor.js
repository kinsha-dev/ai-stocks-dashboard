/**
 * ai_etf_monitor.js  —  AI Sector ETF Monitor v2.0
 *
 * Tracks AI/semiconductor ETFs, earnings for major AI names,
 * AI-themed news from dedicated sources, and per-ticker news for the
 * 5 top picks from the AI screener.
 *
 * ETFs: BOTZ, AIQ, SOXX, SMH, ARKQ, IRBO, QTUM
 * Earnings: NVDA, MSFT, GOOGL, META, TSLA, AMD, AVGO, AMZN, INTC, SMCI
 * AI news sources: VentureBeat AI, TechCrunch AI, CNBC Tech, Reuters Tech
 * Top picks news: Yahoo Finance RSS per screener ticker
 *
 * Output: ai_etf_data.json  (read by dashboard_writer.js)
 * Export: fetchAIETFData()
 */

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const AI_ETF_FILE    = path.join(__dirname, "ai_etf_data.json");
const SCREENER_FILE  = path.join(__dirname, "screener_results.json");
const HOT_STOCKS_FILE = path.join(__dirname, "hot_stocks.json");

// ── HOT STOCK TICKER WATCHLIST ────────────────────────────────────────────────
// Broad set of AI/tech tickers scanned for in news headlines.
// Includes screener universe + large caps we watch but don't screen.
const TICKER_WATCHLIST = new Set([
    // Large-cap AI names (excluded from screener but tracked in news)
    "NVDA","AMD","MSFT","GOOGL","GOOG","META","AMZN","AAPL","TSLA","AVGO",
    "ARM","QCOM","TSM","INTC","ASML","AMAT","LRCX","KLAC","DELL","ANET",
    "PLTR","CRM","NOW","ORCL","IBM","ADBE","CDNS","SNPS","CRWD","PANW",
    // HBM / Memory
    "MU","WDC","RMBS","AMKR","ENTG","CAMT","ICHR","AZTA",
    // AI Infra / Cloud / GPU Compute
    "SMCI","APLD","VRT","CRDO","IREN","CORZ","WULF","NBIS","RXT","DBRG",
    "VNET","GDS","UNIT","PSTG","NTNX","HPE","ALAB","MPWR","WOLF","AEHR",
    "HUT","BTBT","BTDR","HIVE","RIOT","MARA","CLSK","BITF","CIFR","GRIID",
    // Semiconductors
    "LSCC","AMBA","CEVA","ACLS","ONTO","NVTS","ALGM","SITM","MXL","TSEM",
    "COHU","FORM","MKSI","ACMR","KLIC","IPGP","HIMX","SWKS",
    // Networking / Optical / Fiber
    "NET","FSLY","INFN","VIAV","CALX","CIEN","GLW","NTAP","COHR","LITE",
    "AAOI","CLFD","BAND",
    // AI Software / Data
    "SOUN","AI","BBAI","UPST","IONQ","RGTI","QBTS",
    "SNOW","DDOG","MDB","CFLT","ESTC","DT","DOCN","PATH","GTLB",
    "MNDY","ASAN","BRZE","HUBS","ZI","PEGA","TOST",
    // AI Security
    "S","ZS","OKTA","TENB","VRNS","CYBR","QLYS","RBRK",
    // AI Healthcare
    "RXRX","SDGR","NTRA","DOCS","VEEV","AGL","REPL","INOD",
    // AI Energy
    "STEM","OKLO","VST","CEG","GEV","TLN","NRG","ENPH","FSLR","BE",
    "HASI","ARRY","AMRC",
    // AI FinTech / Other
    "AFRM","SOFI","HOOD","UPST","BLZE","EVC","AMBQ","RBLX","U","DUOL",
]);


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

// Dedicated AI/tech RSS sources — all HTTPS, graceful failure
const AI_NEWS_SOURCES = [
    { host: "venturebeat.com",   path: "/category/ai/feed/",                    name: "VentureBeat AI", max: 6 },
    { host: "techcrunch.com",    path: "/tag/artificial-intelligence/feed/",     name: "TechCrunch AI",  max: 6 },
    { host: "www.cnbc.com",      path: "/id/19854910/device/rss/rss.html",       name: "CNBC Tech",      max: 5 },
    { host: "feeds.reuters.com", path: "/reuters/technologyNews",                name: "Reuters Tech",   max: 5 },
];

// ── SENTIMENT SCORING ─────────────────────────────────────────────────────────

const BULLISH = ["surge","rally","soar","gain","rise","climb","jump","beat","record","bull","strong","growth","boost","profit","recover","rebound","positive","upside","exceed","outperform","upgrade","breakout","boom","optimism","launch","partnership","deal","wins","breakthrough"];
const BEARISH  = ["crash","plunge","drop","fall","decline","slump","sell-off","recession","inflation","tariff","layoff","downgrade","miss","warning","fear","risk","concern","crisis","weak","loss","debt","slowdown","cut","ban","probe","investigation","penalty","fine","recall"];

function scoreTitle(t) {
    const h = (t || "").toLowerCase();
    let s = 0;
    for (const w of BULLISH) if (h.includes(w)) s++;
    for (const w of BEARISH) if (h.includes(w)) s--;
    return Math.max(-3, Math.min(3, s));
}

// ── RSS HELPERS ───────────────────────────────────────────────────────────────

function cleanXML(s) {
    return (s || "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();
}

function parseRSS(xml, sourceName, maxItems) {
    const blocks = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/g) || [];
    return blocks.slice(0, maxItems).flatMap(block => {
        const title = cleanXML((
            block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
            block.match(/<title>([\s\S]*?)<\/title>/)
        )?.[1] || "");
        const url = (
            block.match(/<link>(.*?)<\/link>/) ||
            block.match(/<guid[^>]*>(.*?)<\/guid>/)
        )?.[1]?.trim() || "";
        const pub = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
        if (title.length < 15) return [];
        return [{ title, url, pubDate: pub, source: sourceName, score: scoreTitle(title) }];
    });
}

function fetchRSS(hostname, urlPath, sourceName, maxItems = 6, redirectCount = 0) {
    return new Promise((resolve) => {
        const opts = {
            hostname, path: urlPath, method: "GET",
            headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)", "Accept": "application/rss+xml,*/*" },
        };
        const req = https.request(opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 2) {
                try {
                    const loc = new URL(res.headers.location);
                    fetchRSS(loc.hostname, loc.pathname + (loc.search || ""), sourceName, maxItems, redirectCount + 1).then(resolve);
                } catch (_) { resolve([]); }
                return;
            }
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try { resolve(parseRSS(raw, sourceName, maxItems)); } catch (_) { resolve([]); }
            });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(12000, () => { req.destroy(); resolve([]); });
        req.end();
    });
}

// ── YAHOO FINANCE HELPERS ─────────────────────────────────────────────────────

function yahooGet(urlPath) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: "query1.finance.yahoo.com", path: urlPath, method: "GET",
              headers: { "User-Agent": "Mozilla/5.0" } },
            (res) => { let raw = ""; res.on("data", c => raw += c); res.on("end", () => resolve(raw)); }
        );
        req.on("error", reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
    });
}

// ── ETF PRICE DATA ────────────────────────────────────────────────────────────

async function fetchETFChart(ticker) {
    const raw    = await yahooGet(`/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=15d`);
    const json   = JSON.parse(raw);
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(`No chart data for ${ticker}`);
    return result;
}

function computeMetrics(ticker, name, theme, chartResult) {
    const q     = chartResult.indicators.quote[0];
    const pairs = (q.close || []).map((v, i) => ({ c: v, vol: q.volume?.[i] ?? 0 })).filter(x => x.c != null);
    if (pairs.length < 2) throw new Error("Insufficient data");

    const n      = pairs.length;
    const price  = pairs[n - 1].c;
    const dayChg  = ((price - pairs[n - 2].c) / pairs[n - 2].c) * 100;
    const weekChg = n >= 5 ? ((price - pairs[n - 5].c) / pairs[n - 5].c) * 100 : null;

    const period = Math.min(14, n - 1);
    let gains = 0, losses = 0;
    for (let i = n - period; i < n; i++) {
        const diff = pairs[i].c - pairs[i - 1].c;
        if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgG = gains / period, avgL = losses / period;
    const rsi  = parseFloat((avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)).toFixed(1));

    const win = Math.min(20, n), k = 2 / (win + 1);
    let ema = pairs.slice(0, win).reduce((s, p) => s + p.c, 0) / win;
    for (let i = win; i < n; i++) ema = pairs[i].c * k + ema * (1 - k);

    const recentVols = pairs.slice(-5).map(p => p.vol);
    const avgVol = recentVols.slice(0, -1).reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length - 1);
    const volRatio = avgVol > 0 ? parseFloat((recentVols[recentVols.length - 1] / avgVol).toFixed(2)) : 1;

    return {
        ticker, name, theme,
        price:    parseFloat(price.toFixed(2)),
        dayChg:   parseFloat(dayChg.toFixed(2)),
        weekChg:  weekChg != null ? parseFloat(weekChg.toFixed(2)) : null,
        rsi, volRatio,
        trend:    price > ema ? "BULL" : "BEAR",
        history:  pairs.slice(-5).map(p => parseFloat(p.c.toFixed(2))),
    };
}

// ── EARNINGS ──────────────────────────────────────────────────────────────────

async function fetchEarnings(ticker) {
    try {
        const raw  = await yahooGet(`/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents,defaultKeyStatistics`);
        const json = JSON.parse(raw);
        const cal  = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
        if (!cal?.earningsDate?.length) return null;
        // Include both past and upcoming (within 45 days past)
        const allDates = cal.earningsDate.map(d => d.fmt || new Date(d.raw * 1000).toISOString().slice(0, 10));
        const date     = allDates[0];
        const epsEst   = cal.earningsAverage?.fmt  || null;
        const epsLow   = cal.earningsLow?.fmt      || null;
        const epsHigh  = cal.earningsHigh?.fmt     || null;
        return { ticker, date, epsEst, epsLow, epsHigh };
    } catch (_) { return null; }
}

// ── AI THEME NEWS ─────────────────────────────────────────────────────────────

function dedupArticles(articles) {
    const seen = new Set();
    return articles.filter(a => {
        const key = a.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ")
            .split(/\s+/).filter(w => w.length > 3).slice(0, 5).join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function fetchAIThemeNews() {
    const results = await Promise.allSettled(
        AI_NEWS_SOURCES.map(s => fetchRSS(s.host, s.path, s.name, s.max))
    );
    const all = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
    const unique = dedupArticles(all);
    console.log(`  [ETF] AI news: ${unique.length} articles from ${results.filter(r => r.status === "fulfilled" && r.value.length).length} sources`);
    return unique;
}

// ── TOP PICKS NEWS ────────────────────────────────────────────────────────────

function loadTopPicks() {
    try {
        const raw = JSON.parse(fs.readFileSync(SCREENER_FILE, "utf8"));
        return (raw.top5 || []).map(s => ({ ticker: s.ticker, name: s.name || s.ticker }));
    } catch (_) { return []; }
}

async function fetchTopPicksNews(picks) {
    if (!picks.length) return [];
    const results = await Promise.allSettled(
        picks.map(({ ticker, name }) =>
            fetchRSS(
                "feeds.finance.yahoo.com",
                `/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
                ticker,
                5
            ).then(articles => ({ ticker, name, articles }))
        )
    );
    return results
        .filter(r => r.status === "fulfilled" && r.value.articles.length > 0)
        .map(r => r.value);
}

// ── SECTOR SENTIMENT ──────────────────────────────────────────────────────────

function sectorSentiment(etfs) {
    const valid = etfs.filter(e => e.dayChg != null);
    if (!valid.length) return { label: "N/A", emoji: "❓", score: 0, avgDayChg: 0, bullCount: 0, bearCount: 0, bullTrend: 0, total: 0 };

    const avgDayChg = valid.reduce((s, e) => s + e.dayChg, 0) / valid.length;
    const bullCount = valid.filter(e => e.dayChg > 0).length;
    const bearCount = valid.length - bullCount;
    const bullTrend = valid.filter(e => e.trend === "BULL").length;
    const majority  = Math.ceil(valid.length * 0.7);

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

// ── HOT STOCK SCANNER ─────────────────────────────────────────────────────────

/**
 * Scans all AI news article titles for ticker mentions.
 * A stock is "hot" if it appears in ≥2 articles with a net positive score.
 * Results saved to hot_stocks.json so the screener picks them up next run.
 *
 * @param {Array} articles - from fetchAIThemeNews()
 * @returns {Array<{ticker, mentions, score, headlines}>}
 */
function scanHotStocks(articles) {
    const mentions = {};   // ticker → { count, score, headlines[] }

    for (const art of articles) {
        const title = (art.title || "").toUpperCase();
        const artScore = art.score ?? scoreTitle(art.title);

        for (const ticker of TICKER_WATCHLIST) {
            // Whole-word match — avoids "AI" matching "PAID" etc.
            const re = new RegExp(`(?<![A-Z])${ticker}(?![A-Z])`);
            if (!re.test(title)) continue;

            if (!mentions[ticker]) mentions[ticker] = { count: 0, score: 0, headlines: [] };
            mentions[ticker].count++;
            mentions[ticker].score += artScore;
            if (mentions[ticker].headlines.length < 3)
                mentions[ticker].headlines.push({ title: art.title, score: artScore });
        }
    }

    // Hot = mentioned ≥2 times with net positive sentiment
    const hot = Object.entries(mentions)
        .filter(([, v]) => v.count >= 2 && v.score > 0)
        .map(([ticker, v]) => ({ ticker, mentions: v.count, score: v.score, headlines: v.headlines }))
        .sort((a, b) => b.score - a.score || b.mentions - a.mentions);

    try {
        fs.writeFileSync(HOT_STOCKS_FILE, JSON.stringify({
            updatedAt: new Date().toISOString(),
            hot,
        }, null, 2), "utf8");
        if (hot.length)
            console.log(`  [HOT] ${hot.length} tickers in news: ${hot.slice(0, 8).map(h => `${h.ticker}(${h.score > 0 ? "+" : ""}${h.score})`).join(" ")}`);
    } catch (e) {
        console.warn(`  [HOT] Write failed: ${e.message}`);
    }

    return hot;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

async function fetchAIETFData() {
    console.log("  [ETF] Fetching AI ETF data...");

    // Fetch ETF prices + earnings + news all in parallel
    const topPicks = loadTopPicks();

    const [etfResults, earningsRaw, aiNews, topPicksNews] = await Promise.all([
        Promise.allSettled(AI_ETFS.map(({ ticker, name, theme }) =>
            fetchETFChart(ticker).then(r => computeMetrics(ticker, name, theme, r))
        )),
        Promise.allSettled(EARNINGS_WATCH.map(t => fetchEarnings(t))),
        fetchAIThemeNews(),
        fetchTopPicksNews(topPicks),
    ]);

    const etfs = etfResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`  [ETF] ${AI_ETFS[i].ticker}: ${r.reason?.message || "failed"}`);
        return { ticker: AI_ETFS[i].ticker, name: AI_ETFS[i].name, theme: AI_ETFS[i].theme,
                 price: null, dayChg: null, weekChg: null, rsi: null, trend: null,
                 volRatio: null, history: [], error: true };
    });

    // Show earnings within ±45 days (past reported + upcoming)
    const cutoffPast = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const earnings = earningsRaw
        .filter(r => r.status === "fulfilled" && r.value)
        .map(r => r.value)
        .filter(e => e.date >= cutoffPast)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 14);

    // Scan all AI news for hot ticker mentions → writes hot_stocks.json
    const hotStocks = scanHotStocks(aiNews);

    const data = {
        timestamp: new Date().toISOString(),
        etfs,
        earnings,
        sentiment:    sectorSentiment(etfs),
        aiNews,
        topPicksNews,
        hotStocks,
    };

    try {
        fs.writeFileSync(AI_ETF_FILE, JSON.stringify(data, null, 2), "utf8");
        console.log(`  [ETF] ${etfs.length} ETFs | ${earnings.length} earnings | ${aiNews.length} AI news | ${topPicksNews.length} picks | ${hotStocks.length} hot tickers`);
    } catch (e) {
        console.warn(`  [ETF] Write failed: ${e.message}`);
    }

    return data;
}

module.exports = { fetchAIETFData, AI_ETF_FILE };
