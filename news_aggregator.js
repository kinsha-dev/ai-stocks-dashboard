/**
 * news_aggregator.js  --  Multi-source News Aggregator v1.0
 *
 * Fetches up to 5 articles from each of 5 financial news RSS feeds
 * in PARALLEL (25 stories total), deduplicates near-identical headlines,
 * scores every headline for bull/bear sentiment, and returns a consolidated
 * sentiment object with the full article list.
 *
 * Sources (fetched concurrently, never sequentially):
 *   1. Yahoo Finance ^NDX   -- index-specific headlines
 *   2. Yahoo Finance QQQ    -- ETF / options-oriented angle
 *   3. Yahoo Finance ^IXIC  -- broad Nasdaq composite view
 *   4. MarketWatch Market Pulse -- breaking short-form news
 *   5. CNBC Markets RSS     -- mainstream financial media
 *
 * Export: fetchAllNews()  ->  Article[]   (scored, deduped, max 25)
 *         aggregateSentiment(articles)  ->  SentimentResult
 *
 * No npm dependencies -- pure Node.js https.
 */

"use strict";

const https = require("https");

// ── SOURCES ───────────────────────────────────────────────────────────────────

const NEWS_SOURCES = [
    {
        name: "Yahoo ^NDX",
        host: "feeds.finance.yahoo.com",
        path: "/rss/2.0/headline?s=%5ENDX&region=US&lang=en-US",
    },
    {
        name: "Yahoo QQQ",
        host: "feeds.finance.yahoo.com",
        path: "/rss/2.0/headline?s=QQQ&region=US&lang=en-US",
    },
    {
        name: "Yahoo ^IXIC",
        host: "feeds.finance.yahoo.com",
        path: "/rss/2.0/headline?s=%5EIXIC&region=US&lang=en-US",
    },
    {
        name: "MarketWatch",
        host: "feeds.marketwatch.com",
        path: "/marketwatch/marketpulse/",
    },
    {
        name: "CNBC Markets",
        host: "www.cnbc.com",
        path: "/id/20910258/device/rss/rss.html",
    },
    // ── General AI news ──────────────────────────────────────────────────────
    {
        name: "Nasdaq Tech",
        host: "www.nasdaq.com",
        path: "/feed/rssoutbound?category=Technology",
    },
    {
        name: "Benzinga",
        host: "www.benzinga.com",
        path: "/feed/",
    },
    {
        name: "InvestorPlace",
        host: "investorplace.com",
        path: "/feed/",
    },
    {
        name: "TheStreet AI",
        host: "www.thestreet.com",
        path: "/rss/latest.xml",
    },
];

const MAX_PER_SOURCE = 5;   // up to 5 per source

// ── SENTIMENT KEYWORDS ────────────────────────────────────────────────────────

const BULLISH_WORDS = [
    "surge", "rally", "soar", "gain", "rise", "climb", "jump", "beat",
    "record", "bull", "strong", "growth", "boost", "profit", "recover",
    "rebound", "positive", "upside", "exceed", "outperform", "rate cut",
    "stimulus", "hired", "jobs added", "expansion", "upgrade", "breakout",
    "accelerat", "boom", "optimism", "confidence", "high", "best",
];

const BEARISH_WORDS = [
    "crash", "plunge", "drop", "fall", "decline", "slump", "sell-off",
    "recession", "inflation", "tariff", "default", "layoff", "downgrade",
    "miss", "warning", "fear", "risk", "concern", "crisis", "weak",
    "loss", "debt", "rate hike", "slowdown", "contraction", "war",
    "sanctions", "bankruptcy", "fraud", "probe", "investigation",
    "uncertainty", "worry", "pressure", "tension", "shrink", "cut",
];

// ── HELPERS ───────────────────────────────────────────────────────────────────

function scoreHeadline(headline) {
    const h = headline.toLowerCase();
    let score = 0;
    for (const w of BULLISH_WORDS) { if (h.includes(w)) score++; }
    for (const w of BEARISH_WORDS) { if (h.includes(w)) score--; }
    return Math.max(-3, Math.min(3, score));
}

function cleanText(s) {
    return (s || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
        .trim();
}

function parseItems(xml, sourceName) {
    const items  = [];
    const blocks = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/g) || [];
    for (const block of blocks.slice(0, MAX_PER_SOURCE)) {
        const titleRaw = (
            block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
            block.match(/<title>([\s\S]*?)<\/title>/)
        )?.[1] || "";
        const title   = cleanText(titleRaw);
        const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
        const linkRaw = (
            block.match(/<link>(.*?)<\/link>/) ||
            block.match(/<guid[^>]*>(.*?)<\/guid>/)
        )?.[1]?.trim() || "";

        if (title.length > 15) {
            items.push({ title, pubDate, link: linkRaw, source: sourceName });
        }
    }
    return items;
}

/**
 * Fetch a single RSS source. Handles redirects (3xx) once.
 * Resolves to [] on any error so one bad source never blocks others.
 */
function fetchSource(source, redirectCount = 0) {
    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: source.host,
                path:     source.path,
                method:   "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; NDX-NewsBot/2.0)",
                    "Accept":     "application/rss+xml, application/xml, text/xml, */*",
                },
            },
            (res) => {
                // Follow one redirect
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 2) {
                    try {
                        const loc   = new URL(res.headers.location);
                        const redir = { ...source, host: loc.hostname, path: loc.pathname + (loc.search || "") };
                        fetchSource(redir, redirectCount + 1).then(resolve);
                    } catch (_) { resolve([]); }
                    return;
                }
                let raw = "";
                res.on("data", c => raw += c);
                res.on("end",  () => {
                    try { resolve(parseItems(raw, source.name)); }
                    catch (_) { resolve([]); }
                });
            }
        );
        req.on("error", () => resolve([]));
        req.setTimeout(9000, () => { req.destroy(); resolve([]); });
        req.end();
    });
}

/**
 * Deduplicate articles whose first 6 significant words match.
 * Catches syndicated stories repeated across sources.
 */
function dedup(articles) {
    const seen = new Set();
    return articles.filter(a => {
        const key = a.title
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3)
            .slice(0, 6)
            .join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Fetch ALL 5 sources in parallel, interleave results for source diversity,
 * deduplicate, cap at 25, score each headline.
 *
 * @returns {Promise<Article[]>}  up to 25 scored articles
 */
async function fetchAllNews() {
    const start   = Date.now();
    const results = await Promise.all(NEWS_SOURCES.map(s => fetchSource(s)));

    // Round-robin interleave: pick one from each source at a time so the
    // final list has diversity rather than 5 Yahoo stories first.
    const interleaved = [];
    const maxLen = Math.max(...results.map(r => r.length));
    for (let i = 0; i < maxLen; i++) {
        for (const r of results) {
            if (r[i]) interleaved.push(r[i]);
        }
    }

    const unique  = dedup(interleaved).slice(0, 25);
    const scored  = unique.map(a => ({ ...a, score: scoreHeadline(a.title) }));

    const counts  = results.map((r, i) => `${NEWS_SOURCES[i].name}:${r.length}`).join(" ");
    console.log(`  [NEWS] ${scored.length} stories in ${Date.now() - start}ms  (${counts})`);

    return scored;
}

/**
 * Aggregate an array of scored articles into a single sentiment result.
 *
 * @param   {Article[]} articles
 * @returns {{ score, label, emoji, articles, sourceCount, storyCount }}
 */
function aggregateSentiment(articles) {
    if (!articles || articles.length === 0) {
        return { score: 0, label: "NEUTRAL", emoji: "📰", articles: [], sourceCount: 0, storyCount: 0 };
    }

    const total   = articles.reduce((s, a) => s + a.score, 0);
    const avg     = total / articles.length;
    const sources = new Set(articles.map(a => a.source)).size;

    let label = "NEUTRAL", emoji = "📰";
    if      (avg >=  1.5) { label = "STRONGLY BULLISH"; emoji = "📈"; }
    else if (avg >=  0.5) { label = "MILD BULL";         emoji = "🟢"; }
    else if (avg <= -1.5) { label = "STRONGLY BEARISH";  emoji = "📉"; }
    else if (avg <= -0.5) { label = "MILD BEAR";         emoji = "🔴"; }

    return {
        score:       parseFloat(avg.toFixed(2)),
        label,
        emoji,
        articles,
        sourceCount: sources,
        storyCount:  articles.length,
    };
}

module.exports = { fetchAllNews, aggregateSentiment };
