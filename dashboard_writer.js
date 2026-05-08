/**
 * dashboard_writer.js  --  Signal Dashboard Generator v1.0
 *
 * Maintains a rolling 5-day history (signals_history.json) and
 * regenerates a fully self-contained dashboard.html after every
 * signal checker poll cycle.
 *
 * The HTML file is standalone -- open it with any browser via file://
 * It auto-reloads every 60 seconds to pick up the latest data.
 *
 * Export: writeDashboard(checkData) -> void
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const HISTORY_FILE   = path.join(__dirname, "signals_history.json");
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");
const MAX_DAYS       = 5;
const MAX_SNAPSHOTS  = MAX_DAYS * 24 * 60 / 5;   // 5 days @ 5-min polls = 1440

// ── HISTORY MANAGEMENT ────────────────────────────────────────────────────────

function loadHistory() {
    try {
        const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
        // Upgrade old single-symbol format (has .snapshots at root) to multi-symbol
        if (Array.isArray(raw.snapshots)) {
            const sym = raw.symbol || "NDX";
            return { [sym]: { symbol: sym, snapshots: raw.snapshots, lastUpdated: raw.lastUpdated || null } };
        }
        return raw;
    } catch (_) { return {}; }
}

function saveHistory(h) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), "utf8");
}

function pruneOld(snapshots) {
    const cutoff = Date.now() - MAX_DAYS * 24 * 3600 * 1000;
    return snapshots.filter(s => new Date(s.ts).getTime() > cutoff).slice(-MAX_SNAPSHOTS);
}

// ── AI SCREENER DATA ──────────────────────────────────────────────────────────

const SCREENER_FILE = path.join(__dirname, "screener_results.json");

function loadScreenerResults() {
    try {
        if (!fs.existsSync(SCREENER_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(SCREENER_FILE, "utf8"));
        if (!raw?.top5?.length) return null;
        return raw;
    } catch (_) { return null; }
}

function buildScreenerSection(sc) {
    if (!sc) return "";
    const ts = sc.timestamp
        ? new Date(sc.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "—";

    function recClr(mean) {
        if (mean <= 1.5) return "#3fb950";
        if (mean <= 2.0) return "#56d364";
        if (mean <= 2.5) return "#8bc34a";
        if (mean <= 3.0) return "#d29922";
        return "#f85149";
    }
    function recLbl(key) {
        const m = { strongbuy: "STRONG BUY", buy: "BUY", hold: "HOLD",
                    sell: "SELL", strongsell: "STRONG SELL" };
        return m[(key || "hold").toLowerCase()] || (key || "—").toUpperCase();
    }
    function fmtPct(v) { return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

    const cards = sc.top5.map((s, i) => {
        const clr      = recClr(s.recMean ?? 3);
        const lbl      = recLbl(s.consensus);
        const uClr     = (s.upsidePct ?? 0) >= 20 ? "#3fb950" : (s.upsidePct ?? 0) >= 5 ? "#d29922" : "#8b949e";
        const dClr     = (s.dayChg ?? 0) >= 0 ? "#3fb950" : "#f85149";
        const flashHtml = (s.flash || []).slice(0, 2)
            .map(f => `<span class="sc-flash">${f}</span>`).join("");
        const topSig   = (s.signals || [])[0] || "";
        const topNewsHtml = s.topStory
            ? `<div class="sc-news">${s.topStory.url
                ? `<a href="${s.topStory.url}" target="_blank" rel="noopener">${s.topStory.title}</a>`
                : s.topStory.title}</div>`
            : "";
        const perfHtml = [["1M", s.perf?.r1m], ["3M", s.perf?.r3m], ["1Y", s.perf?.r1y]]
            .map(([l, v]) => `<span class="sc-perf-cell"><span class="sc-perf-lbl">${l}</span><span style="color:${(v ?? 0) >= 0 ? "#3fb950" : "#f85149"}">${fmtPct(v)}</span></span>`)
            .join("");

        return `<div class="sc-card">
  <div class="sc-head">
    <span class="sc-medal">${medals[i]}</span>
    <a href="https://finance.yahoo.com/quote/${s.ticker}" target="_blank" rel="noopener" class="sc-ticker">${s.ticker}</a>
    <span class="sc-score">${s.score}<sup>/100</sup></span>
  </div>
  <div class="sc-name">${s.name}</div>
  <div class="sc-row">
    <span class="sc-con" style="color:${clr}">${lbl}</span>
    ${s.targetMean > 0 ? `<span class="sc-upside" style="color:${uClr}">$${s.targetMean.toFixed(0)} (+${(s.upsidePct || 0).toFixed(0)}%)</span>` : ""}
  </div>
  <div class="sc-row">
    <span style="color:${dClr};font-size:11px;font-weight:600">${(s.dayChg ?? 0) >= 0 ? "+" : ""}${(s.dayChg || 0).toFixed(2)}% today</span>
  </div>
  <div class="sc-perf">${perfHtml}</div>
  ${flashHtml ? `<div class="sc-flashes">${flashHtml}</div>` : ""}
  ${topSig ? `<div class="sc-sig">${topSig}</div>` : ""}
  ${topNewsHtml}
</div>`;
    }).join("\n");

    // Flash alerts row
    const allFlash = sc.top5.flatMap(s =>
        (s.flash || []).slice(0, 1).map(f => `<b>${s.ticker}</b>: ${f}`)
    );
    const alertBar = allFlash.length
        ? `<div class="sc-alerts">⚡ ${allFlash.join(" &nbsp;&nbsp; ")}</div>`
        : "";

    return `<div id="sc-section">
  <div class="sc-header">
    <span class="sc-title">🤖 AI Top Picks</span>
    <span class="sc-sub">${sc.analyzed || 50} stocks screened</span>
    <span class="sc-ts">Updated ${ts}</span>
    <a href="#" class="sc-run-link" onclick="alert('Run: node ai_screener.js');return false">↻ Refresh</a>
  </div>
  ${alertBar}
  <div class="sc-grid">${cards}</div>
</div>`;
}

// ── SNAPSHOT BUILDER ──────────────────────────────────────────────────────────

function buildSnapshot({ classic, sweep, fvg, vol, news, options, prediction, spread, ai }) {
    return {
        ts:    new Date().toISOString(),
        price: parseFloat(classic.price.toFixed(2)),

        signal: classic.strongBuy  ? "STRONG_BUY"
               : classic.strongSell ? "STRONG_SELL"
               : classic.longSignal ? "BUY"
               : classic.shortSignal ? "SELL"
               : "NONE",

        prediction: {
            bias:       prediction.bias,
            confidence: prediction.confidence,
            bull:       prediction.bull,
            bear:       prediction.bear,
        },

        classic: {
            rsi:       parseFloat(classic.rsi.toFixed(1)),
            macd:      classic.macd  ? parseFloat(classic.macd.toFixed(2))  : null,
            bullScore: classic.bullScore,
            bearScore: classic.bearScore,
            bullTrend: classic.bullTrend,
            ema9:      parseFloat(classic.ema9.toFixed(2)),
            ema21:     parseFloat(classic.ema21.toFixed(2)),
            ema200:    parseFloat(classic.ema200.toFixed(2)),
        },

        smc: {
            sweep:         sweep.bullishSweep ? "BULL" : sweep.bearishSweep ? "BEAR" : null,
            sweptLevel:    sweep.sweptLevel ? parseFloat(sweep.sweptLevel.toFixed(2)) : null,
            inBullFVG:     fvg.inBullFVG,
            inBearFVG:     fvg.inBearFVG,
            unfilledBull:  fvg.unfilledBull,
            unfilledBear:  fvg.unfilledBear,
            volRatio:      parseFloat(vol.volRatio.toFixed(2)),
            buyingClimax:  vol.buyingClimax,
            sellingClimax: vol.sellingClimax,
            absorption:    vol.absorption,
            deltaProxy:    parseFloat(vol.deltaProxy.toFixed(2)),
        },

        news: {
            label:       news.label,
            score:       news.score,
            emoji:       news.emoji,
            storyCount:  news.storyCount || news.articles?.length || 0,
            sourceCount: news.sourceCount || 1,
            topStories:  (news.articles || []).slice(0, 15).map(a => ({
                title:  a.title,
                score:  a.score,
                source: a.source || "?",
                url:    a.link   || a.url || null,
            })),
        },

        options: options ? {
            gexM:         parseFloat((options.levels.totalGEX / 1e6).toFixed(1)),
            posGEX:       options.levels.posGEX,
            gammaPin:     options.levels.gammaPin,
            gammaFlip:    options.levels.gammaFlip,
            callWall:     options.levels.callWall,
            putWall:      options.levels.putWall,
            maxPain:      options.maxPain,
            pcrVolume:    options.flow.pcrVolume,
            pcrOI:        options.flow.pcrOI,
            dte:          options.dte,
            expiry:       options.expiry,
            unusualCalls: (options.flow.unusualCalls || []).slice(0, 3).map(c => ({ strike: c.strike, ratio: c.ratio })),
            unusualPuts:  (options.flow.unusualPuts  || []).slice(0, 3).map(p => ({ strike: p.strike, ratio: p.ratio })),
            optScore:     { bull: options.score.bull, bear: options.score.bear },
        } : null,

        spread: spread?.recommended ? {
            strategy:     spread.recommended.strategy,
            direction:    spread.recommended.direction,
            type:         spread.recommended.type,
            trendLabel:   spread.recommended.trendLabel   ?? null,
            netDebit:     spread.recommended.netDebit     ?? null,
            netCredit:    spread.recommended.netCredit    ?? null,
            maxProfit:    spread.recommended.maxProfit,
            maxLoss:      spread.recommended.maxLoss,
            riskReward:   spread.recommended.riskReward,
            breakEven:    spread.recommended.breakEven ?? spread.recommended.upperBreakEven ?? null,
            profitZone:   spread.recommended.profitZone   ?? null,
            targetPrice:  spread.recommended.targetPrice  ?? null,
            targetNote:   spread.recommended.targetNote   ?? null,
            probOfProfit: spread.recommended.probOfProfit ?? null,
            ivRegime:     spread.ivRegime     ?? null,
            creditOrDebit: spread.creditOrDebit ?? null,
            legs:         spread.recommended.legs,
            rationale:    spread.rationale || [],
            alternatives: (spread.alternatives || []).slice(0, 2).map(a => ({
                strategy: a.strategy, direction: a.direction, type: a.type,
                netDebit: a.netDebit ?? null, netCredit: a.netCredit ?? null,
                riskReward: a.riskReward,
            })),
        } : null,

        ai: ai ? {
            model:       ai.model,
            action:      ai.action,
            conviction:  ai.conviction,
            timeHorizon: ai.time_horizon || ai.timeHorizon || null,
            strategy:    ai.strategy     || null,
            entryZone:   ai.entry_zone   || null,
            stopLoss:    ai.stop_loss    || null,
            target:      ai.target       || null,
            reasoning:   ai.reasoning    || null,
            risks:       ai.risks        || null,
        } : null,
    };
}

// ── MAIN ENTRIES ──────────────────────────────────────────────────────────────

/**
 * Write dashboard for multiple symbols at once.
 * @param {{ [symbol: string]: object }} results  e.g. { NDX: checkData, SPX: checkData }
 */
function writeDashboardMulti(results) {
    try {
        const history = loadHistory();
        const ts      = new Date().toISOString();

        for (const [sym, checkData] of Object.entries(results)) {
            if (!history[sym]) history[sym] = { symbol: sym, snapshots: [], lastUpdated: ts };
            const snapshot          = buildSnapshot(checkData);
            history[sym].lastUpdated = ts;
            history[sym].snapshots   = pruneOld([...(history[sym].snapshots || []), snapshot]);
        }

        saveHistory(history);
        generateHTML(history);
        const counts = Object.entries(history).map(([s, d]) => `${s}:${(d.snapshots||[]).length}`).join(" ");
        console.log(`  [DASH] dashboard.html updated  (${counts})`);
    } catch (e) {
        console.warn(`  [DASH] Write failed: ${e.message}`);
    }
}

/** Backward-compatible single-symbol write. */
function writeDashboard(checkData, symbol) {
    const sym = symbol || process.env.SYMBOL || "NDX";
    writeDashboardMulti({ [sym]: checkData });
}

// ── HTML GENERATION ───────────────────────────────────────────────────────────

/** history shape: { NDX: { symbol, snapshots, lastUpdated }, SPX: { ... } } */
function generateHTML(history) {
    const safeJson = JSON.stringify(history)
        .replace(/<\/script>/gi, "<\\/script>")
        .replace(/<!--/g, "<\\!--");
    const screener     = loadScreenerResults();
    const screenerHtml = buildScreenerSection(screener);
    const html = HTML_TEMPLATE
        .replace("__DASHBOARD_DATA__", safeJson)
        .replace("__SCREENER_HTML__",  screenerHtml);
    fs.writeFileSync(DASHBOARD_FILE, html, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML TEMPLATE
// Auto-reloads every 60 s. Works via file:// — no server required.
// ─────────────────────────────────────────────────────────────────────────────

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NDX / SPX Signal Dashboard</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--bull:#3fb950;--bear:#f85149;--neutral:#d29922;--blue:#58a6ff;--purple:#bc8cff;--orange:#e3823e;--teal:#56d364}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5}
a{color:var(--blue);text-decoration:none}
/* HEADER */
#header{background:linear-gradient(90deg,#0d1117,#161b22);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:20px;position:sticky;top:0;z-index:100}
#header .sym{font-size:18px;font-weight:700;color:var(--blue)}
#header .price{font-size:22px;font-weight:700}
#header .trend-badge{padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
#header .ts{margin-left:auto;color:var(--muted);font-size:12px;text-align:right}
#header .reload-bar{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px}
#countdown{color:var(--teal)}
/* CARDS ROW */
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;padding:14px 20px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.card .label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.card .value{font-size:18px;font-weight:700}
.card .sub{font-size:11px;color:var(--muted);margin-top:3px}
.conf-bar{height:6px;background:var(--bg3);border-radius:3px;margin-top:6px;overflow:hidden}
.conf-bar-fill{height:100%;border-radius:3px;transition:width .4s}
/* SPARKLINE */
.sparkline-wrap{margin:0 20px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.sparkline-wrap h3{font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;letter-spacing:.06em}
.sparkline-svg{width:100%;height:90px}
/* SECTION TITLES */
.sec-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:4px 20px 6px;margin-top:4px}
/* HISTORY TABLE */
#history-wrap{margin:0 20px 14px;overflow:auto;max-height:340px;background:var(--bg2);border:1px solid var(--border);border-radius:8px}
table{width:100%;border-collapse:collapse}
thead{position:sticky;top:0;background:var(--bg3);z-index:10}
th{padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid #21262d;vertical-align:top;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.03)}
/* BADGES */
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.bg-bull{background:rgba(63,185,80,.18);color:var(--bull)}
.bg-bear{background:rgba(248,81,73,.18);color:var(--bear)}
.bg-neutral{background:rgba(210,153,34,.18);color:var(--neutral)}
.bg-blue{background:rgba(88,166,255,.18);color:var(--blue)}
.bg-purple{background:rgba(188,140,255,.18);color:var(--purple)}
.bg-none{background:var(--bg3);color:var(--muted)}
.bull{color:var(--bull)}
.bear{color:var(--bear)}
.neutral{color:var(--neutral)}
.muted{color:var(--muted)}
/* 3-COLUMN LOWER GRID */
.lower-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:0 20px 14px}
.panel{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px}
.panel h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border)}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--muted);font-size:12px}
.kv .v{font-weight:600;font-size:12px}
.leg-row{display:flex;gap:6px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--border)}
.leg-row:last-child{border-bottom:none}
.leg-action{width:36px;font-weight:700;font-size:11px}
.leg-detail{flex:1;font-size:12px}
.leg-meta{font-size:11px;color:var(--muted)}
.ai-action{font-size:26px;font-weight:800;margin-bottom:6px}
.ai-meta{display:flex;gap:10px;margin-bottom:10px}
.reasoning{font-size:12px;color:var(--text);line-height:1.5;background:var(--bg3);border-radius:6px;padding:8px}
.risks{font-size:11px;color:var(--muted);margin-top:6px;font-style:italic}
.levels-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.level-pill{padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600}
.gex-bar{height:8px;background:var(--bg3);border-radius:4px;margin:6px 0;overflow:hidden;position:relative}
.gex-fill{height:100%;border-radius:4px}
/* NEWS FEED */
#news-wrap{margin:0 20px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px}
#news-wrap h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px}
.news-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:6px}
.news-item{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;background:var(--bg3)}
.news-score{width:26px;text-align:center;font-weight:700;font-size:12px;flex-shrink:0;padding-top:1px}
.news-src{font-size:10px;color:var(--muted);margin-bottom:1px}
.news-title{font-size:12px;line-height:1.4}
.news-title a{color:inherit;text-decoration:none}
.news-title a:hover{color:var(--blue);text-decoration:underline}
/* FOOTER */
#footer{text-align:center;padding:14px;color:var(--muted);font-size:11px;border-top:1px solid var(--border)}
/* TABS */
#tabs-bar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 20px;display:flex;gap:0}
.tab-btn{background:none;border:none;border-bottom:3px solid transparent;color:var(--muted);cursor:pointer;font-size:13px;font-weight:600;letter-spacing:.04em;padding:10px 20px;transition:color .15s,border-color .15s}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--blue);border-bottom-color:var(--blue)}
.tab-panel{display:none}
.tab-panel.active{display:block}
/* AI SCREENER SECTION */
#sc-section{background:linear-gradient(180deg,#0a1628 0%,#0d1117 100%);border-bottom:2px solid rgba(88,166,255,.25);padding:12px 20px 14px}
.sc-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.sc-title{font-size:14px;font-weight:800;color:var(--blue);letter-spacing:-.3px}
.sc-sub{font-size:11px;color:var(--muted)}
.sc-ts{margin-left:auto;font-size:11px;color:var(--muted)}
.sc-run-link{font-size:11px;color:var(--blue);cursor:pointer}
.sc-alerts{font-size:11px;color:#d29922;background:rgba(210,153,34,.08);border-radius:5px;padding:4px 10px;margin-bottom:8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sc-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.sc-card{background:rgba(22,27,34,.8);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;transition:border-color .15s}
.sc-card:hover{border-color:var(--blue)}
.sc-head{display:flex;align-items:center;gap:5px}
.sc-medal{font-size:13px}
.sc-ticker{font-size:16px;font-weight:800;color:var(--blue);text-decoration:none}
.sc-ticker:hover{text-decoration:underline}
.sc-score{margin-left:auto;font-size:18px;font-weight:900;color:var(--bull);line-height:1}
.sc-score sup{font-size:9px;font-weight:400;color:var(--muted)}
.sc-name{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
.sc-con{font-size:10px;font-weight:700;letter-spacing:.03em}
.sc-upside{font-size:10px;font-weight:600}
.sc-perf{display:flex;gap:3px}
.sc-perf-cell{display:flex;flex-direction:column;align-items:center;background:var(--bg3);border-radius:3px;padding:2px 5px;flex:1}
.sc-perf-lbl{font-size:8px;color:var(--muted);text-transform:uppercase}
.sc-perf-cell span:last-child{font-size:10px;font-weight:700}
.sc-flashes{display:flex;flex-wrap:wrap;gap:3px}
.sc-flash{font-size:9px;font-weight:700;background:rgba(210,153,34,.12);color:#d29922;border-radius:3px;padding:1px 5px;white-space:nowrap}
.sc-sig{font-size:9px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sc-news{font-size:10px;color:var(--muted);border-top:1px solid var(--border);padding-top:4px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sc-news a{color:var(--muted)}
.sc-news a:hover{color:var(--blue)}
@media(max-width:1100px){.sc-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.sc-grid{grid-template-columns:repeat(2,1fr)}}
/* SCROLLBAR */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg2)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
/* RESPONSIVE */
@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}.lower-grid{grid-template-columns:1fr}.news-grid{grid-template-columns:1fr}}
@media(max-width:500px){.cards{grid-template-columns:1fr}}
</style>
</head>
<body>
__SCREENER_HTML__
<div id="app"></div>
<script>
const _D = __DASHBOARD_DATA__;
</script>
<script>
// ── HELPERS ──────────────────────────────────────────────────────────────────
const $ = (s,p=document) => p.querySelector(s);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function fmt(n,d=2){return n==null?'--':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})}
function fmtP(n){return n==null?'--':Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtTs(ts){
  const d=new Date(ts);
  const today=new Date(); const yesterday=new Date(today); yesterday.setDate(today.getDate()-1);
  const tStr=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  if(d.toDateString()===today.toDateString()) return tStr;
  if(d.toDateString()===yesterday.toDateString()) return 'Yest '+tStr;
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+tStr;
}
function fmtDay(ts){
  const d=new Date(ts);
  return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
}

function sigBadge(sig){
  const map={
    'STRONG_BUY': ['bg-bull','🚀 STRONG BUY'],
    'STRONG_SELL':['bg-bear','🔴 STRONG SELL'],
    'BUY':        ['bg-bull','▲ BUY'],
    'SELL':       ['bg-bear','▼ SELL'],
    'NONE':       ['bg-none','— NONE'],
  };
  const [cls,lbl]=map[sig]||['bg-none',sig||'—'];
  return \`<span class="badge \${cls}">\${esc(lbl)}</span>\`;
}

function biasBadge(bias,conf){
  const cls=bias==='BULL'?'bg-bull':bias==='BEAR'?'bg-bear':'bg-neutral';
  return \`<span class="badge \${cls}">\${esc(bias)} \${conf}%</span>\`;
}

function aiBadge(ai){
  if(!ai) return '<span class="badge bg-none muted">—</span>';
  const cls=ai.action==='BUY'?'bg-bull':ai.action==='SELL'?'bg-bear':ai.action==='HOLD'?'bg-blue':'bg-neutral';
  const conv=ai.conviction==='HIGH'?'🔥':ai.conviction==='MEDIUM'?'✓':'~';
  return \`<span class="badge \${cls}">\${conv} \${esc(ai.action)}</span>\`;
}

function newsBadge(n){
  if(!n) return '<span class="badge bg-none muted">—</span>';
  const cls=n.score>=1?'bg-bull':n.score<=-1?'bg-bear':'bg-neutral';
  return \`<span class="badge \${cls}">\${esc(n.emoji)} \${esc(n.label)}</span>\`;
}

function spreadBadge(sp){
  if(!sp) return '<span class="badge bg-none muted">—</span>';
  const cls=sp.direction==='BULL'?'bg-bull':sp.direction==='BEAR'?'bg-bear':sp.direction==='VOLATILE'?'bg-orange':'bg-purple';
  // Show trendLabel if available, else shorten the strategy name
  const lbl=sp.trendLabel||(sp.strategy||'').replace(' Spread','').replace('Long ','');
  return \`<span class="badge \${cls}">\${esc(lbl)}</span>\`;
}

function smcBadge(smc){
  if(!smc) return '';
  const parts=[];
  if(smc.sweep==='BULL') parts.push('<span class="badge bg-bull" style="font-size:10px">⚡ BullSweep</span>');
  if(smc.sweep==='BEAR') parts.push('<span class="badge bg-bear" style="font-size:10px">⚡ BearSweep</span>');
  if(smc.inBullFVG) parts.push('<span class="badge bg-bull" style="font-size:10px">FVG↑</span>');
  if(smc.inBearFVG) parts.push('<span class="badge bg-bear" style="font-size:10px">FVG↓</span>');
  if(smc.buyingClimax)  parts.push('<span class="badge bg-neutral" style="font-size:10px">VolCLX↑</span>');
  if(smc.sellingClimax) parts.push('<span class="badge bg-neutral" style="font-size:10px">VolCLX↓</span>');
  return parts.join(' ');
}

function trendColor(bullTrend){return bullTrend?'var(--bull)':'var(--bear)'}
function confColor(c){return c>=70?'var(--bull)':c>=50?'var(--neutral)':'var(--bear)'}

// ── SPARKLINE SVG ─────────────────────────────────────────────────────────────
function buildSparkline(snapshots, sym, W=900, H=90){
  sym=sym||'x';
  if(snapshots.length<2) return '<text fill="#8b949e" x="10" y="50" font-size="12">Not enough data yet</text>';
  const pts=snapshots.slice(-120); // last ~10h at 5-min polls
  const prices=pts.map(s=>s.price);
  const mn=Math.min(...prices), mx=Math.max(...prices);
  const rng=mx-mn||1;
  const pad=10;
  const xs=pts.map((_,i)=>pad+i/(pts.length-1)*(W-pad*2));
  const ys=pts.map(p=>H-pad-(p-mn)/rng*(H-pad*2));
  const lineD='M'+xs.map((x,i)=>x.toFixed(1)+','+ys[i].toFixed(1)).join('L');
  const areaD=lineD+'L'+(W-pad)+','+(H-pad)+'L'+pad+','+(H-pad)+'Z';
  const last=pts[pts.length-1];
  const prev=pts[pts.length-2];
  const up=last.price>=prev.price;
  const clr=up?'#3fb950':'#f85149';

  // Signal markers (dots on the line)
  const markers=pts.map((s,i)=>{
    if(s.signal==='NONE'||!s.signal) return '';
    const isBuy=s.signal.includes('BUY');
    const c=isBuy?'#3fb950':'#f85149';
    return \`<circle cx="\${xs[i].toFixed(1)}" cy="\${ys[i].toFixed(1)}" r="3.5" fill="\${c}" stroke="#0d1117" stroke-width="1.5"/>\`;
  }).join('');

  // Today/yesterday separator lines
  const dayLines=[];
  let prevDay='';
  pts.forEach((s,i)=>{
    const d=new Date(s.ts).toDateString();
    if(d!==prevDay&&prevDay!==''){
      dayLines.push(\`<line x1="\${xs[i].toFixed(1)}" y1="0" x2="\${xs[i].toFixed(1)}" y2="\${H}" stroke="#30363d" stroke-width="1" stroke-dasharray="3,3"/>\`);
      dayLines.push(\`<text x="\${(xs[i]+2).toFixed(1)}" y="12" font-size="9" fill="#8b949e">\${fmtDay(s.ts)}</text>\`);
    }
    prevDay=d;
  });

  return \`<defs><linearGradient id="ag-\${sym}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="\${clr}" stop-opacity=".35"/><stop offset="100%" stop-color="\${clr}" stop-opacity=".02"/></linearGradient></defs>\`
    +dayLines.join('')
    +\`<path d="\${areaD}" fill="url(#ag-\${sym})"/>\`
    +\`<path d="\${lineD}" fill="none" stroke="\${clr}" stroke-width="1.8"/>\`
    +markers
    +\`<text x="\${(W-pad+3).toFixed(1)}" y="\${(ys[ys.length-1]+4).toFixed(1)}" font-size="10" fill="\${clr}" font-weight="600">$\${fmtP(last.price)}</text>\`;
}

// ── RENDER FUNCTIONS ──────────────────────────────────────────────────────────

function renderHeader(latest, symData){
  const sym=symData?.symbol||'NDX';
  const trend=latest?.classic?.bullTrend;
  const tClr=trend?'var(--bull)':'var(--bear)';
  const tLbl=trend?'▲ BULL':'▼ BEAR';
  const lu=symData?.lastUpdated?new Date(symData.lastUpdated).toLocaleString():'—';
  return \`<div id="header-\${sym}" style="background:linear-gradient(90deg,#0d1117,#161b22);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:20px">
  <span class="sym">\${esc(sym)}</span>
  <span class="price" style="color:\${tClr}">$\${fmtP(latest?.price)}</span>
  <span class="trend-badge" style="background:rgba(\${trend?'63,185,80':'248,81,73'},.15);color:\${tClr}">\${tLbl}</span>
  <div style="display:flex;gap:10px;align-items:center">
    <span class="badge \${latest?.signal!=='NONE'&&latest?.signal?'bg-bull':''}" style="\${!latest?.signal||latest.signal==='NONE'?'background:var(--bg3);color:var(--muted)':''}">\${esc(latest?.signal||'—')}</span>
    \${latest?.ai?aiBadge(latest.ai):''}
  </div>
  <div class="ts">Last update: \${lu}<br>
    <div class="reload-bar">Auto-reload in <span id="countdown">60</span>s &nbsp;<span style="cursor:pointer;color:var(--blue)" onclick="location.reload()">↻ Refresh now</span></div>
  </div>
</div>\`;
}

function renderCards(latest){
  if(!latest) return '<div class="cards"><div class="card"><div class="value muted">No data yet</div></div></div>';
  const conf=latest.prediction?.confidence||0;
  const cfill=confColor(conf);
  const aiConv=latest.ai?.conviction;
  const convClr=aiConv==='HIGH'?'var(--bull)':aiConv==='MEDIUM'?'var(--neutral)':'var(--muted)';
  const aiAction=latest.ai?.action||'—';
  const aiClr=aiAction==='BUY'?'var(--bull)':aiAction==='SELL'?'var(--bear)':'var(--muted)';
  const nScore=latest.news?.score||0;
  const nClr=nScore>=0.5?'var(--bull)':nScore<=-0.5?'var(--bear)':'var(--neutral)';
  const sp=latest.spread;
  const spClr=sp?.direction==='BULL'?'var(--bull)':sp?.direction==='BEAR'?'var(--bear)':'var(--purple)';

  return \`<div class="cards">
  <div class="card">
    <div class="label">Signal</div>
    <div style="margin-top:2px">\${sigBadge(latest.signal)}</div>
    <div class="sub">\${smcBadge(latest.smc)||'No SMC event'}</div>
  </div>
  <div class="card">
    <div class="label">Prediction</div>
    <div class="value" style="color:\${cfill}">\${conf}%</div>
    <div class="sub">\${esc(latest.prediction?.bias||'—')} — Bull:\${latest.prediction?.bull||0}pts Bear:\${latest.prediction?.bear||0}pts</div>
    <div class="conf-bar"><div class="conf-bar-fill" style="width:\${conf}%;background:\${cfill}"></div></div>
  </div>
  <div class="card">
    <div class="label">AI Advisor (\${esc(latest.ai?.model||'—')})</div>
    <div class="value" style="color:\${aiClr}">\${esc(aiAction)}</div>
    <div class="sub" style="color:\${convClr}">\${esc(aiConv||'—')} conviction &bull; \${esc(latest.ai?.timeHorizon||'—')}</div>
    \${latest.ai?.entryZone?'<div class="sub">Entry: '+esc(latest.ai.entryZone)+'</div>':''}
  </div>
  <div class="card">
    <div class="label">News (\${latest.news?.storyCount||0} stories / \${latest.news?.sourceCount||0} srcs)</div>
    <div class="value" style="color:\${nClr}">\${esc(latest.news?.emoji||'')} \${esc(latest.news?.label||'—')}</div>
    <div class="sub">Score: \${nScore>0?'+':''}\${nScore}</div>
  </div>
  <div class="card">
    <div class="label">Spread</div>
    <div style="margin-top:2px">\${spreadBadge(sp)}</div>
    \${sp?'<div class="sub" style="color:'+spClr+'">R/R: '+esc(String(sp.riskReward))+'x &bull; '+esc(sp.type==='debit'?'Debit $'+sp.netDebit:'Credit $'+sp.netCredit)+'</div>':'<div class="sub muted">No options data</div>'}
  </div>
</div>\`;
}

function renderSparkline(snapshots, sym){
  const pts=snapshots.filter(s=>s.price);
  return \`<div class="sparkline-wrap" id="sparkline-wrap-\${sym}">
  <h3>Price History &amp; Signals — Last \${pts.length} checks &nbsp;<span style="color:var(--bull)">● BUY signals</span> &nbsp;<span style="color:var(--bear)">● SELL signals</span></h3>
  <svg class="sparkline-svg" id="sparkline-\${sym}" viewBox="0 0 900 90" preserveAspectRatio="none">\${buildSparkline(pts,sym)}</svg>
</div>\`;
}

function renderHistoryTable(snapshots){
  const rows=[...snapshots].reverse().slice(0,100);
  const trs=rows.map(s=>{
    const priceClr=s.classic?.bullTrend?'var(--bull)':'var(--bear)';
    return \`<tr>
      <td style="color:var(--muted)">\${fmtTs(s.ts)}</td>
      <td style="font-weight:600;color:\${priceClr}">$\${fmtP(s.price)}</td>
      <td>\${sigBadge(s.signal)}</td>
      <td>\${biasBadge(s.prediction?.bias,s.prediction?.confidence)}</td>
      <td>\${s.classic?'<span style="color:var(--muted)">RSI '+s.classic.rsi+'</span>':''} \${s.classic?'<span class="'+(s.classic.bullScore>=3?'bull':s.classic.bearScore>=3?'bear':'muted')+'">S:'+s.classic.bullScore+'/'+s.classic.bearScore+'</span>':''}</td>
      <td>\${newsBadge(s.news)}</td>
      <td>\${aiBadge(s.ai)}</td>
      <td>\${spreadBadge(s.spread)}</td>
      <td>\${smcBadge(s.smc)||'<span class="muted">—</span>'}</td>
    </tr>\`;
  }).join('');
  return \`<div class="sec-title">5-Day Signal History (\${rows.length} checks)</div>
<div id="history-wrap">
  <table>
    <thead><tr>
      <th>Time</th><th>Price</th><th>Signal</th><th>Bias</th><th>Classic</th><th>News</th><th>AI</th><th>Spread</th><th>SMC Events</th>
    </tr></thead>
    <tbody>\${trs}</tbody>
  </table>
</div>\`;
}

function renderOptionsPanel(opt){
  if(!opt) return \`<div class="panel"><h3>Options Chain (QQQ)</h3><p style="color:var(--muted);font-size:12px">No options data</p></div>\`;
  const gexAbsPct=Math.min(100,Math.abs(opt.gexM)/100*100);
  const gexClr=opt.posGEX?'var(--bull)':'var(--bear)';
  const pcrClr=opt.pcrVolume>1.5?'var(--bull)':opt.pcrVolume<0.5?'var(--bear)':'var(--neutral)';
  const uCalls=(opt.unusualCalls||[]).map(c=>\`<span class="badge bg-bull" style="font-size:10px">C$\${c.strike} \${c.ratio}x</span>\`).join(' ');
  const uPuts=(opt.unusualPuts||[]).map(p=>\`<span class="badge bg-bear" style="font-size:10px">P$\${p.strike} \${p.ratio}x</span>\`).join(' ');
  return \`<div class="panel"><h3>Options Chain — \${esc(opt.expiry||'—')} (\${opt.dte} DTE)</h3>
  <div class="kv"><span class="k">GEX</span><span class="v" style="color:\${gexClr}">\${opt.gexM>0?'+':''}\${opt.gexM}M \${opt.posGEX?'[+stabilizing]':'[- trending]'}</span></div>
  <div class="gex-bar"><div class="gex-fill" style="width:\${gexAbsPct.toFixed(0)}%;background:\${gexClr};opacity:.8"></div></div>
  <div class="kv"><span class="k">γ Pin (magnet)</span><span class="v">\${esc(opt.gammaPin?'$'+opt.gammaPin:'—')}</span></div>
  <div class="kv"><span class="k">γ Flip (regime)</span><span class="v">\${opt.gammaFlip?'<span style="color:var(--neutral)">$'+opt.gammaFlip+'</span>':'<span class="muted">—</span>'}</span></div>
  <div class="kv"><span class="k">Call Wall (resist)</span><span class="v bear">\${esc(opt.callWall?'$'+opt.callWall:'—')}</span></div>
  <div class="kv"><span class="k">Put Wall (support)</span><span class="v bull">\${esc(opt.putWall?'$'+opt.putWall:'—')}</span></div>
  <div class="kv"><span class="k">Max Pain</span><span class="v">\${esc(opt.maxPain?'$'+opt.maxPain:'—')}</span></div>
  <div class="kv"><span class="k">PCR Volume</span><span class="v" style="color:\${pcrClr}">\${opt.pcrVolume}</span></div>
  <div class="kv"><span class="k">PCR OI</span><span class="v">\${opt.pcrOI}</span></div>
  \${uCalls||uPuts?'<div style="margin-top:8px;font-size:10px;color:var(--muted);margin-bottom:4px">UNUSUAL ACTIVITY</div>':''}
  \${uCalls?'<div style="margin-bottom:3px">'+uCalls+'</div>':''}
  \${uPuts?'<div>'+uPuts+'</div>':''}
</div>\`;
}

function renderSpreadPanel(sp){
  if(!sp) return \`<div class="panel"><h3>Spread Recommendation</h3><p style="color:var(--muted);font-size:12px">No options chain available</p></div>\`;

  // Colours keyed to direction
  const dir=sp.direction||'';
  const clr=dir==='BULL'?'var(--bull)':dir==='BEAR'?'var(--bear)':dir==='VOLATILE'?'var(--orange)':'var(--purple)';
  const bgClr=dir==='BULL'?'rgba(63,185,80,.12)':dir==='BEAR'?'rgba(248,81,73,.12)':dir==='VOLATILE'?'rgba(227,130,62,.12)':'rgba(188,140,255,.12)';

  // ── Trend label banner ────────────────────────────────────────────────────────
  const trendLbl=sp.trendLabel||dir||'—';
  const cdBadge=sp.creditOrDebit
    ? \`<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;background:\${sp.creditOrDebit==='CREDIT'?'rgba(88,166,255,.15)':'rgba(188,140,255,.15)'};color:\${sp.creditOrDebit==='CREDIT'?'var(--blue)':'var(--purple)'}">\${esc(sp.creditOrDebit)}</span>\`
    : '';

  // ── Target price highlight ────────────────────────────────────────────────────
  const targetBlock=sp.targetPrice!=null
    ? \`<div style="margin:10px 0;padding:10px 12px;background:\${bgClr};border:1px solid \${clr};border-radius:8px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:\${clr};margin-bottom:3px">MAX PROFIT TARGET</div>
        <div style="font-size:22px;font-weight:800;color:\${clr}">$\${fmt(sp.targetPrice,2)}</div>
        \${sp.targetNote?'<div style="font-size:11px;color:var(--muted);margin-top:3px">'+esc(sp.targetNote)+'</div>':''}
      </div>\`
    : '';

  // ── IV regime line ────────────────────────────────────────────────────────────
  const ivLine=sp.ivRegime
    ? \`<div class="kv" style="margin-top:6px"><span class="k">IV Regime</span><span class="v" style="font-size:11px;color:var(--muted)">\${esc(sp.ivRegime)}</span></div>\`
    : '';

  // ── Option legs ───────────────────────────────────────────────────────────────
  const legs=(sp.legs||[]).map(leg=>{
    const lClr=leg.action==='BUY'?'var(--bull)':'var(--bear)';
    return \`<div class="leg-row">
      <span class="leg-action" style="color:\${lClr}">\${esc(leg.action)}</span>
      <span class="leg-detail">\${esc(leg.type)} <strong>$\${esc(String(leg.strike))}</strong></span>
      <span class="leg-meta">IV:\${esc(String(leg.iv))}% &nbsp; θ$\${esc(String(leg.theorPrice))}\${leg.delta!=null?' &nbsp; δ'+esc(String(leg.delta)):''}</span>
    </div>\`;
  }).join('');

  // ── P&L block ─────────────────────────────────────────────────────────────────
  const plLine=sp.type==='debit'
    ? \`<div class="kv"><span class="k">Net Debit</span><span class="v bear">$\${sp.netDebit}</span></div>
       <div class="kv"><span class="k">Max Profit</span><span class="v bull">$\${sp.maxProfit} / contract</span></div>
       <div class="kv"><span class="k">Max Loss</span><span class="v bear">$\${sp.maxLoss} / contract</span></div>
       \${sp.breakEven?'<div class="kv"><span class="k">Break-even</span><span class="v">$'+sp.breakEven+'</span></div>':''}\`
    : \`<div class="kv"><span class="k">Net Credit</span><span class="v bull">$\${sp.netCredit}</span></div>
       <div class="kv"><span class="k">Max Profit (keep credit)</span><span class="v bull">$\${sp.maxProfit} / contract</span></div>
       <div class="kv"><span class="k">Max Loss</span><span class="v bear">$\${sp.maxLoss} / contract</span></div>
       \${sp.profitZone?'<div class="kv"><span class="k">Profit Zone</span><span class="v">'+esc(sp.profitZone)+'</span></div>':''}\`;

  // ── Alternatives ──────────────────────────────────────────────────────────────
  const alts=(sp.alternatives||[]).map(a=>{
    const cost=a.netDebit!=null?'Debit $'+a.netDebit:a.netCredit!=null?'Credit $'+a.netCredit:'';
    return \`<div style="font-size:11px;color:var(--muted);padding:2px 0">↳ \${esc(a.strategy)} &bull; \${cost} &bull; R/R \${esc(String(a.riskReward))}x</div>\`;
  }).join('');

  return \`<div class="panel">
  <h3>Spread Recommendation</h3>

  <!-- Trend banner -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
    <span style="font-size:20px;font-weight:800;color:\${clr}">\${esc(trendLbl)}</span>
    \${cdBadge}
  </div>
  <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">\${esc(sp.strategy)}</div>

  <!-- Target price highlight box -->
  \${targetBlock}

  <!-- Legs -->
  <div style="margin-bottom:8px">\${legs}</div>

  <!-- P&L + IV -->
  <div style="border-top:1px solid var(--border);padding-top:8px">
    \${plLine}
    <div class="kv"><span class="k">Risk / Reward</span><span class="v" style="color:\${clr}">\${sp.riskReward}x</span></div>
    \${sp.probOfProfit!=null?'<div class="kv"><span class="k">Prob of Profit</span><span class="v">'+sp.probOfProfit+'%</span></div>':''}
    \${ivLine}
  </div>

  <!-- Alternatives -->
  \${alts?'<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)"><div style="font-size:10px;text-transform:uppercase;color:var(--muted);margin-bottom:3px">Alternatives</div>'+alts+'</div>':''}

  <!-- Rationale -->
  \${(sp.rationale||[]).length?'<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)">'+sp.rationale.map(r=>'&bull; '+esc(r)).join('<br>')+'</div>':''}
</div>\`;
}

function renderAIPanel(ai){
  if(!ai) return \`<div class="panel"><h3>AI Trade Advisor</h3><p style="color:var(--muted);font-size:12px">Ollama not running or model not pulled.<br><br><code style="font-size:11px">ollama pull gemma4:latest</code></p></div>\`;
  const clr=ai.action==='BUY'?'var(--bull)':ai.action==='SELL'?'var(--bear)':'var(--muted)';
  const convClr=ai.conviction==='HIGH'?'var(--bull)':ai.conviction==='MEDIUM'?'var(--neutral)':'var(--muted)';
  return \`<div class="panel"><h3>AI Advisor — \${esc(ai.model||'gemma4:latest')}</h3>
  <div class="ai-action" style="color:\${clr}">\${esc(ai.action||'—')}</div>
  <div class="ai-meta">
    <span class="badge" style="background:rgba(255,255,255,.07);color:\${convClr}">\${esc(ai.conviction||'—')} conviction</span>
    \${ai.timeHorizon?'<span class="badge bg-blue">'+esc(ai.timeHorizon)+'</span>':''}
  </div>
  \${ai.strategy?'<div class="kv"><span class="k">Strategy</span><span class="v">'+esc(ai.strategy)+'</span></div>':''}
  \${ai.entryZone?'<div class="kv"><span class="k">Entry</span><span class="v">'+esc(ai.entryZone)+'</span></div>':''}
  \${ai.stopLoss?'<div class="kv"><span class="k">Stop</span><span class="v bear">'+esc(ai.stopLoss)+'</span></div>':''}
  \${ai.target?'<div class="kv"><span class="k">Target</span><span class="v bull">'+esc(ai.target)+'</span></div>':''}
  \${ai.reasoning?'<div class="reasoning" style="margin-top:10px">'+esc(ai.reasoning)+'</div>':''}
  \${ai.risks?'<div class="risks">⚠ '+esc(ai.risks)+'</div>':''}
</div>\`;
}

function renderNewsFeed(news){
  if(!news||!news.topStories||!news.topStories.length){
    return \`<div id="news-wrap"><h3>News Feed</h3><p style="color:var(--muted);font-size:12px">No stories available</p></div>\`;
  }
  const items=news.topStories.map(a=>{
    const sc=a.score;
    const sClr=sc>=2?'var(--bull)':sc>=1?'#56d364':sc<=-2?'var(--bear)':sc<=-1?'#f07070':'var(--muted)';
    const bg=sc>=1?'rgba(63,185,80,.06)':sc<=-1?'rgba(248,81,73,.06)':'var(--bg3)';
    const sign=sc>0?'+':'';
    const titleHtml=a.url
      ? \`<a href="\${esc(a.url)}" target="_blank" rel="noopener noreferrer">\${esc(a.title)}</a>\`
      : esc(a.title);
    return \`<div class="news-item" style="background:\${bg}">
      <span class="news-score" style="color:\${sClr}">\${sign}\${sc}</span>
      <div>
        <div class="news-src">\${esc(a.source||'?')}</div>
        <div class="news-title">\${titleHtml}</div>
      </div>
    </div>\`;
  }).join('');
  return \`<div id="news-wrap">
  <h3>News Feed — \${news.storyCount} stories from \${news.sourceCount} sources &nbsp; \${news.emoji} \${esc(news.label)} (avg: \${news.score>0?'+':''}\${news.score})</h3>
  <div class="news-grid">\${items}</div>
</div>\`;
}

// ── TAB RENDER ────────────────────────────────────────────────────────────────
function renderTabContent(sym){
  const symData=_D[sym]||{symbol:sym,snapshots:[]};
  const snaps=symData.snapshots||[];
  const latest=snaps.length?snaps[snaps.length-1]:null;
  return renderHeader(latest,symData)
   +renderCards(latest)
   +renderSparkline(snaps,sym)
   +renderHistoryTable(snaps)
   +'<div class="lower-grid">'
   +renderOptionsPanel(latest?.options)
   +renderSpreadPanel(latest?.spread)
   +renderAIPanel(latest?.ai)
   +'</div>'
   +renderNewsFeed(latest?.news)
   +\`<div id="footer">\${esc(sym)} Signal Dashboard &bull; \${snaps.length} snapshots &bull; last 5 days &bull; Auto-reload every 60s</div>\`;
}

// ── MAIN RENDER ───────────────────────────────────────────────────────────────
let _activeTab=Object.keys(_D)[0]||'NDX';

function switchTab(sym){
  _activeTab=sym;
  // Update button active states
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.sym===sym));
  // Show/hide panels
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+sym));
}

function render(){
  const syms=Object.keys(_D);
  // Build tab bar
  const tabBar='<div id="tabs-bar">'+syms.map(s=>\`<button class="tab-btn\${s===_activeTab?' active':''}" data-sym="\${s}" onclick="switchTab('\${s}')">\${esc(s)}</button>\`).join('')+'</div>';
  // Build tab panels (all rendered, CSS shows/hides)
  const panels=syms.map(s=>\`<div id="tab-\${s}" class="tab-panel\${s===_activeTab?' active':''}">\${renderTabContent(s)}</div>\`).join('');
  document.getElementById('app').innerHTML=tabBar+panels;
}

render();

// ── AUTO-RELOAD COUNTDOWN ─────────────────────────────────────────────────────
let secs=60;
setInterval(()=>{
  secs--;
  document.querySelectorAll('#countdown').forEach(el=>el.textContent=secs);
  if(secs<=0) location.reload();
},1000);
</script>
</body>
</html>`;

/**
 * Re-render dashboard.html using the existing signals history + latest screener data.
 * Call this after ai_screener.js writes screener_results.json so the dashboard
 * reflects the new picks immediately without waiting for the next signal_checker poll.
 */
function regenerateDashboard() {
    try {
        const history = loadHistory();
        generateHTML(history);
        console.log("  [DASH] dashboard.html refreshed with latest screener picks");
    } catch (e) {
        console.warn(`  [DASH] regenerateDashboard failed: ${e.message}`);
    }
}

module.exports = { writeDashboard, writeDashboardMulti, regenerateDashboard };
