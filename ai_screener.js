/**
 * ai_screener.js  --  Daily AI Stock Screener v1.0
 *
 * Screens 50 AI-related stocks and filters to TOP 5 high-conviction picks.
 *
 * Analysis layers:
 *   Technical   — EMA trend, RSI, MACD, Bollinger Bands, volume
 *   Performance — 1W / 1M / 3M / 6M / 1Y returns + relative strength rank
 *   Analyst     — consensus rating, price target, upside %, recent upgrades
 *   Sentiment   — news headline scoring, fresh catalyst detection
 *
 * Outputs:
 *   screener_results.json  — picked up by dashboard_writer.js on next poll
 *                            (top 5 section appears at the top of dashboard.html)
 *
 * Usage:  node ai_screener.js
 * Daily:  scheduled via start_screener.js or cron
 */

"use strict";

const https     = require("https");
const fs        = require("fs");
const path      = require("path");
const { spawnSync } = require("child_process");

// Lazy-load to avoid circular deps — dashboard_writer is optional
function tryRegenerateDashboard() {
    try {
        const { regenerateDashboard } = require("./dashboard_writer");
        regenerateDashboard();
    } catch (_) { /* dashboard_writer not available — skip */ }
}

const OUT_DIR  = __dirname;
const JSON_OUT = path.join(OUT_DIR, "screener_results.json");

// ── Python interpreter — uses the local venv so all packages (yfinance, etc.)
//    are available without touching the system Python.
//    Adjust this path if the venv lives somewhere else.
const PYTHON   = path.join(__dirname, "my_trading_env", "bin", "python3");
const BATCH_SIZE   = 5;
const BATCH_DELAY  = 700;   // ms between batches (Yahoo Finance rate limit)

// ─────────────────────────────────────────────────────────────────────────────
// STOCK UNIVERSE — 100 AI & Related Stocks  (small / mid cap only, ~<$50B)
// Large-cap mega-techs (NVDA, AMD, MSFT, GOOGL, AMZN, META, AAPL, TSLA,
// AVGO, ARM, QCOM, TSM, INTC, ASML, AMAT, LRCX, KLAC, DELL, ANET, PLTR,
// CRM, NOW, ORCL, IBM, ADBE, CDNS, SNPS, ADSK, CRWD, PANW, MSTR) excluded.
// ─────────────────────────────────────────────────────────────────────────────

const AI_STOCKS = [
    // ── AI Infrastructure / Data-Center Power ────────────────────────────────
    { ticker: "SMCI",  name: "Super Micro Computer",   sector: "AI Infrastructure" },
    { ticker: "APLD",  name: "Applied Digital",        sector: "AI Infrastructure" },
    { ticker: "VRT",   name: "Vertiv Holdings",        sector: "AI Infrastructure" },
    { ticker: "CRDO",  name: "Credo Technology",       sector: "AI Networking" },
    { ticker: "IREN",  name: "Iris Energy",            sector: "AI Compute" },
    { ticker: "CORZ",  name: "Core Scientific",        sector: "AI Compute" },
    { ticker: "WULF",  name: "TeraWulf",               sector: "AI Compute" },

    // ── AI Semiconductors — Small / Mid Cap ──────────────────────────────────
    { ticker: "LSCC",  name: "Lattice Semiconductor",  sector: "AI Chips" },
    { ticker: "AMBA",  name: "Ambarella",              sector: "AI Edge Chips" },
    { ticker: "CEVA",  name: "CEVA Inc",               sector: "AI Chip IP" },
    { ticker: "ACLS",  name: "Axcelis Technologies",   sector: "Semicon Equip" },
    { ticker: "ONTO",  name: "Onto Innovation",        sector: "Semicon Equip" },
    { ticker: "COHU",  name: "Cohu",                   sector: "Semi Test" },
    { ticker: "NVTS",  name: "Navitas Semiconductor",  sector: "AI Chips" },
    { ticker: "ALGM",  name: "Allegro MicroSystems",   sector: "AI Chips" },
    { ticker: "SITM",  name: "SiTime Corp",            sector: "AI Chips" },
    { ticker: "FORM",  name: "FormFactor",             sector: "Semi Test" },
    { ticker: "MKSI",  name: "MKS Instruments",        sector: "Semicon Equip" },
    { ticker: "ACMR",  name: "ACM Research",           sector: "Semicon Equip" },
    { ticker: "KLIC",  name: "Kulicke & Soffa",        sector: "Semicon Equip" },
    { ticker: "IPGP",  name: "IPG Photonics",          sector: "AI Laser/Optical" },

    // ── AI Networking / Optical / Edge ───────────────────────────────────────
    { ticker: "NET",   name: "Cloudflare",             sector: "AI Edge/CDN" },
    { ticker: "FSLY",  name: "Fastly",                 sector: "AI Edge" },
    { ticker: "INFN",  name: "Infinera",               sector: "AI Networking" },
    { ticker: "VIAV",  name: "Viavi Solutions",        sector: "AI Networking" },
    { ticker: "CALX",  name: "Calix Networks",         sector: "AI Broadband" },

    // ── AI Pure Plays / Voice / Vision ───────────────────────────────────────
    { ticker: "SOUN",  name: "SoundHound AI",          sector: "AI Voice" },
    { ticker: "AI",    name: "C3.ai",                  sector: "AI Software" },
    { ticker: "BBAI",  name: "BigBear.ai",             sector: "AI Analytics" },
    { ticker: "UPST",  name: "Upstart Holdings",       sector: "AI FinTech" },
    { ticker: "LPSN",  name: "LivePerson",             sector: "Conversational AI" },
    { ticker: "CRNC",  name: "Cerence",                sector: "AI Automotive" },
    { ticker: "GENI",  name: "Genius Sports",          sector: "AI Sports Data" },

    // ── Quantum Computing ─────────────────────────────────────────────────────
    { ticker: "IONQ",  name: "IonQ",                   sector: "Quantum" },
    { ticker: "RGTI",  name: "Rigetti Computing",      sector: "Quantum" },
    { ticker: "QBTS",  name: "D-Wave Quantum",         sector: "Quantum" },
    { ticker: "QUBT",  name: "Quantum Computing Inc",  sector: "Quantum" },
    { ticker: "ARQQ",  name: "Arqit Quantum",          sector: "Quantum" },

    // ── AI Cybersecurity ──────────────────────────────────────────────────────
    { ticker: "S",     name: "SentinelOne",            sector: "AI Security" },
    { ticker: "ZS",    name: "Zscaler",                sector: "AI Security" },
    { ticker: "OKTA",  name: "Okta",                   sector: "AI Identity" },
    { ticker: "TENB",  name: "Tenable Holdings",       sector: "AI Security" },
    { ticker: "VRNS",  name: "Varonis Systems",        sector: "AI Security" },
    { ticker: "CYBR",  name: "CyberArk Software",      sector: "AI Security" },
    { ticker: "QLYS",  name: "Qualys",                 sector: "AI Security" },
    { ticker: "RBRK",  name: "Rubrik",                 sector: "AI Security" },

    // ── AI Data / Analytics / Cloud ───────────────────────────────────────────
    { ticker: "SNOW",  name: "Snowflake",              sector: "AI Data" },
    { ticker: "DDOG",  name: "Datadog",                sector: "AI Observability" },
    { ticker: "MDB",   name: "MongoDB",                sector: "AI Data" },
    { ticker: "CFLT",  name: "Confluent",              sector: "AI Data Stream" },
    { ticker: "ESTC",  name: "Elastic",                sector: "AI Search" },
    { ticker: "DT",    name: "Dynatrace",              sector: "AI Observability" },
    { ticker: "DOCN",  name: "DigitalOcean",           sector: "AI Cloud" },
    { ticker: "ALTR",  name: "Altair Engineering",     sector: "AI Simulation" },
    { ticker: "CWAN",  name: "Clearwater Analytics",   sector: "AI Investment" },

    // ── AI Enterprise SaaS ────────────────────────────────────────────────────
    { ticker: "PATH",  name: "UiPath",                 sector: "AI Automation" },
    { ticker: "GTLB",  name: "GitLab",                 sector: "AI DevOps" },
    { ticker: "MNDY",  name: "Monday.com",             sector: "AI Work Mgmt" },
    { ticker: "ASAN",  name: "Asana",                  sector: "AI Work Mgmt" },
    { ticker: "FRSH",  name: "Freshworks",             sector: "AI CRM" },
    { ticker: "BRZE",  name: "Braze",                  sector: "AI Marketing" },
    { ticker: "NCNO",  name: "nCino",                  sector: "AI Banking" },
    { ticker: "ZI",    name: "ZoomInfo Technologies",  sector: "AI Sales Intel" },
    { ticker: "HUBS",  name: "HubSpot",                sector: "AI CRM" },
    { ticker: "WK",    name: "Workiva",                sector: "AI Reporting" },
    { ticker: "PEGA",  name: "Pegasystems",            sector: "AI BPM" },
    { ticker: "SMAR",  name: "Smartsheet",             sector: "AI Work Mgmt" },
    { ticker: "TOST",  name: "Toast Inc",              sector: "AI Restaurant Tech" },
    { ticker: "DV",    name: "DoubleVerify",           sector: "AI Ad Verification" },
    { ticker: "SPT",   name: "Sprout Social",          sector: "AI Social Media" },

    // ── AI Healthcare / Drug Discovery ────────────────────────────────────────
    { ticker: "RXRX",  name: "Recursion Pharmaceuticals", sector: "AI Drug Discovery" },
    { ticker: "SDGR",  name: "Schrödinger",            sector: "AI Drug Discovery" },
    { ticker: "ABSI",  name: "Absci",                  sector: "AI Biotech" },
    { ticker: "NTRA",  name: "Natera",                 sector: "AI Genomics" },
    { ticker: "DOCS",  name: "Doximity",               sector: "AI Healthcare" },
    { ticker: "VEEV",  name: "Veeva Systems",          sector: "AI Life Sciences" },
    { ticker: "ACCD",  name: "Accolade",               sector: "AI Healthcare" },
    { ticker: "PHR",   name: "Phreesia",               sector: "AI Healthcare" },
    { ticker: "WEAV",  name: "Weave Communications",   sector: "AI Healthcare Comm" },

    // ── AI FinTech ────────────────────────────────────────────────────────────
    { ticker: "AFRM",  name: "Affirm Holdings",        sector: "AI Lending" },
    { ticker: "SOFI",  name: "SoFi Technologies",      sector: "AI Banking" },
    { ticker: "HOOD",  name: "Robinhood Markets",      sector: "AI Investing" },
    { ticker: "LC",    name: "LendingClub",            sector: "AI Lending" },
    { ticker: "PAYO",  name: "Payoneer Global",        sector: "AI Payments" },
    { ticker: "TASK",  name: "TaskUs",                 sector: "AI Services" },

    // ── AI Robotics / Autonomous / Space ─────────────────────────────────────
    { ticker: "LAZR",  name: "Luminar Technologies",   sector: "AI Lidar" },
    { ticker: "MBLY",  name: "Mobileye Global",        sector: "AI Autonomous" },
    { ticker: "JOBY",  name: "Joby Aviation",          sector: "AI Air Mobility" },
    { ticker: "ACHR",  name: "Archer Aviation",        sector: "AI Air Taxis" },
    { ticker: "PRCT",  name: "Procept Biorobotics",    sector: "AI Surgery" },
    { ticker: "LUNR",  name: "Intuitive Machines",     sector: "AI Space" },

    // ── AI Gaming / 3D / Education ────────────────────────────────────────────
    { ticker: "RBLX",  name: "Roblox",                 sector: "AI Gaming" },
    { ticker: "U",     name: "Unity Technologies",     sector: "AI Gaming/3D" },
    { ticker: "DUOL",  name: "Duolingo",               sector: "AI Education" },
    { ticker: "COUR",  name: "Coursera",               sector: "AI Education" },

    // ── AI Energy & Nuclear (powering data centers) ───────────────────────────
    { ticker: "STEM",  name: "Stem Inc",               sector: "AI Energy" },
    { ticker: "OKLO",  name: "Oklo",                   sector: "Nuclear/AI Power" },
    { ticker: "VST",   name: "Vistra Corp",            sector: "AI Energy" },
    { ticker: "CEG",   name: "Constellation Energy",   sector: "Nuclear/AI Power" },
    { ticker: "GEV",   name: "GE Vernova",             sector: "AI Energy Infra" },
    { ticker: "TLN",   name: "Talen Energy",           sector: "AI Energy" },
    { ticker: "NRG",   name: "NRG Energy",             sector: "AI Energy" },
    { ticker: "ENPH",  name: "Enphase Energy",         sector: "AI CleanTech" },
    { ticker: "FSLR",  name: "First Solar",            sector: "AI CleanTech" },
    { ticker: "HASI",  name: "HA Sustainable Infra",   sector: "AI Energy Finance" },
    { ticker: "ARRY",  name: "Array Technologies",     sector: "AI CleanTech" },
    { ticker: "AMRC",  name: "Ameresco",               sector: "AI Energy" },

    // ── AI Infrastructure (servers, storage, networking) ─────────────────────
    { ticker: "PSTG",  name: "Pure Storage",           sector: "AI Storage" },
    { ticker: "NTNX",  name: "Nutanix",                sector: "AI Cloud Infra" },
    { ticker: "CIEN",  name: "Ciena Corp",             sector: "AI Networking" },
    { ticker: "GLW",   name: "Corning",                sector: "AI Optical" },
    { ticker: "NTAP",  name: "NetApp",                 sector: "AI Storage" },
    { ticker: "COHR",  name: "Coherent Corp",          sector: "AI Optical" },
    { ticker: "HPE",   name: "HPE",                    sector: "AI Infrastructure" },

    // ── AI Marketing / Analytics / Other ─────────────────────────────────────
    { ticker: "OPEN",  name: "Opendoor Technologies",  sector: "AI Real Estate" },
    { ticker: "DOMO",  name: "Domo Inc",               sector: "AI Business Intel" },
    { ticker: "VERX",  name: "Vertex Inc",             sector: "AI Tax Software" },

    // ── User watchlist additions ──────────────────────────────────────────────
    { ticker: "NBIS",  name: "Nebius Group",           sector: "AI Cloud Infra" },
    { ticker: "BE",    name: "Bloom Energy",           sector: "AI Energy" },
    { ticker: "TSEM",  name: "Tower Semiconductor",    sector: "AI Chips" },
    { ticker: "RXT",   name: "Rackspace Technology",   sector: "AI Cloud Managed" },
    { ticker: "INOD",  name: "Innodata Inc",           sector: "AI Data Services" },
    { ticker: "MXL",   name: "MaxLinear",              sector: "AI Connectivity" },
    { ticker: "BAND",  name: "Bandwidth Inc",          sector: "AI Communications" },
    { ticker: "BLZE",  name: "Backblaze",              sector: "AI Cloud Storage" },
    { ticker: "AGL",   name: "agilon health",          sector: "AI Healthcare" },
    { ticker: "AMBQ",  name: "Ambient AI",             sector: "AI Security" },
    { ticker: "EVC",   name: "Entravision Comms",      sector: "AI AdTech" },
    { ticker: "REPL",  name: "Replimune Group",        sector: "AI Drug Discovery" },

    // ── HBM (High Bandwidth Memory) Ecosystem ────────────────────────────────
    { ticker: "MU",    name: "Micron Technology",      sector: "HBM Memory" },
    { ticker: "RMBS",  name: "Rambus",                 sector: "HBM Controller IP" },
    { ticker: "AMKR",  name: "Amkor Technology",       sector: "HBM Packaging" },
    { ticker: "ENTG",  name: "Entegris",               sector: "HBM Materials" },
    { ticker: "CAMT",  name: "Camtek",                 sector: "HBM Inspection" },
    { ticker: "ICHR",  name: "Ichor Holdings",         sector: "Semi Equipment Parts" },
    { ticker: "AZTA",  name: "Azenta",                 sector: "Wafer Handling" },
    { ticker: "WDC",   name: "Western Digital",        sector: "AI Storage/Memory" },

    // ── GPU / AI Accelerator Power ────────────────────────────────────────────
    { ticker: "ALAB",  name: "Astera Labs",            sector: "GPU Connectivity" },
    { ticker: "MPWR",  name: "Monolithic Power Sys",   sector: "GPU Power" },
    { ticker: "WOLF",  name: "Wolfspeed",              sector: "SiC Power Semi" },
    { ticker: "AEHR",  name: "Aehr Test Systems",      sector: "AI Chip Test" },

    // ── Data Center Lease / Infrastructure ───────────────────────────────────
    { ticker: "DBRG",  name: "DigitalBridge Group",    sector: "Data Center Lease" },
    { ticker: "VNET",  name: "21Vianet Group",         sector: "Data Center Lease" },
    { ticker: "GDS",   name: "GDS Holdings",           sector: "Data Center Lease" },
    { ticker: "UNIT",  name: "Uniti Group",            sector: "Fiber/DC Infra" },

    // ── Fiber Optics / Optical Interconnect ──────────────────────────────────
    { ticker: "LITE",  name: "Lumentum Holdings",      sector: "AI Fiber Optics" },
    { ticker: "AAOI",  name: "Applied Optoelectronics",sector: "AI Fiber Optics" },
    { ticker: "CLFD",  name: "Clearfield Inc",         sector: "Fiber Connectivity" },
];

// ─────────────────────────────────────────────────────────────────────────────
// YAHOO FINANCE HTTP CLIENT
// ─────────────────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let _cookie = "";
let _crumb  = "";

function httpsGet(url, extraHeaders = {}, _redirects = 0) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }
        const opts = {
            hostname: parsed.hostname,
            path:     parsed.pathname + parsed.search,
            method:   "GET",
            headers:  { "User-Agent": UA, "Accept-Encoding": "identity", ...extraHeaders },
        };
        const req = https.request(opts, res => {
            if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location && _redirects < 5) {
                // Resolve relative redirects against the request's origin
                let loc = res.headers.location;
                if (!loc.startsWith("http")) loc = `${parsed.protocol}//${parsed.host}${loc}`;
                // Drain the response body before following redirect
                res.resume();
                return resolve(httpsGet(loc, extraHeaders, _redirects + 1));
            }
            const chunks = [];
            const sc = res.headers["set-cookie"] || [];
            res.on("data", c => chunks.push(c));
            res.on("end",  () => resolve({
                status:  res.statusCode,
                body:    Buffer.concat(chunks).toString("utf8"),
                cookies: sc,
                headers: res.headers,
            }));
        });
        req.on("error", reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
    });
}

async function ensureCrumb() {
    if (_crumb && _cookie) return;
    try {
        // Step 1: land on Yahoo Finance to collect session cookies
        const r1 = await httpsGet("https://finance.yahoo.com/quote/AAPL", {});
        _cookie = (r1.cookies || []).map(c => c.split(";")[0]).filter(Boolean).join("; ");

        // Step 2: fetch crumb — try query2 first (more lenient), then query1
        for (const host of ["query2", "query1"]) {
            const r2 = await httpsGet(
                `https://${host}.finance.yahoo.com/v1/test/getcrumb`,
                { "Cookie": _cookie, "Accept": "text/plain" }
            );
            if (r2.status === 200 && r2.body && r2.body.length < 60 && !r2.body.includes("<")) {
                _crumb = r2.body.trim();
                break;
            }
        }
        console.log(`  [YF AUTH] cookie=${_cookie ? "✓" : "✗"} crumb=${_crumb ? `"${_crumb.slice(0,8)}…"` : "✗ MISSING"}`);
    } catch (e) {
        console.warn(`  [YF AUTH] ensureCrumb error: ${e.message}`);
    }
}

async function yfFetch(url) {
    await ensureCrumb();
    const sep  = url.includes("?") ? "&" : "?";
    const auth = _crumb ? `${sep}crumb=${encodeURIComponent(_crumb)}` : "";
    const headers = { "Cookie": _cookie, "Accept": "application/json" };
    try {
        const r = await httpsGet(`${url}${auth}`, headers);
        if (r.status === 401 || r.status === 403) {
            // Crumb expired — reset and re-fetch once
            _cookie = ""; _crumb = "";
            await ensureCrumb();
            const auth2 = _crumb ? `${sep}crumb=${encodeURIComponent(_crumb)}` : "";
            return httpsGet(`${url}${auth2}`, { "Cookie": _cookie, "Accept": "application/json" });
        }
        return r;
    } catch (e) {
        return { status: 0, body: "", error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PYTHON-BASED BULK FETCHER (replaces per-stock Node.js HTTP calls)
// Uses yf_fetch.py which uses the yfinance Python library — not rate-blocked
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV + analyst + news for all tickers in one Python subprocess call.
 * Returns a map:  { TICKER: { ohlcv, analyst, news } | { error } }
 */
function fetchAllViaYFinance(stocks) {
    const tickers = stocks.map(s => s.ticker);
    const pyScript = path.join(__dirname, "yf_fetch.py");

    if (!fs.existsSync(pyScript)) {
        console.error(`  [YF] ❌ yf_fetch.py not found at: ${pyScript}`);
        console.error(`  [YF]    Create yf_fetch.py in the same folder as ai_screener.js`);
        return {};
    }

    // ── Preflight: verify venv python + yfinance before committing to full batch ─
    const preCheck = spawnSync(PYTHON, ["-c", "import yfinance; print(yfinance.__version__)"], {
        timeout: 10_000, encoding: "buffer",
    });
    if (preCheck.error || preCheck.status !== 0) {
        const hint = preCheck.error?.message || preCheck.stderr?.toString("utf8")?.trim() || "";
        console.error(`  [YF] ❌ venv python not available: ${hint}`);
        console.error(`  [YF]    Expected: ${PYTHON}`);
        console.error(`  [YF]    Fix: cd <project> && python3 -m venv my_trading_env && my_trading_env/bin/pip install yfinance`);
        return {};
    }
    const yfVer = preCheck.stdout?.toString("utf8")?.trim() || "?";
    console.log(`  [YF] venv python ✓  yfinance ${yfVer}  (${PYTHON})`);

    console.log(`  [YF] Spawning yf_fetch.py for ${tickers.length} tickers…`);
    const result = spawnSync(PYTHON, [pyScript, ...tickers], {
        timeout:    360_000,    // 6 min max (50 stocks + pauses)
        maxBuffer:  50_000_000, // 50 MB
        encoding:   "buffer",
    });

    if (result.error) {
        console.error(`  [YF] ❌ subprocess error: ${result.error.message}`);
        if (result.error.message.includes("ETIMEDOUT") || result.error.code === "ETIMEDOUT") {
            console.error(`  [YF]    Timed out — try reducing batch or check network`);
        }
        return {};
    }

    // Print progress from stderr (ticker-by-ticker OK/error lines)
    if (result.stderr) {
        const stderrText = result.stderr.toString("utf8").trim();
        if (stderrText) process.stdout.write(stderrText + "\n");
    }

    if (result.status !== 0) {
        const errText = result.stderr ? result.stderr.toString("utf8").slice(-400) : "";
        console.error(`  [YF] ❌ python3 exited ${result.status}`);
        if (errText) console.error(`  [YF]    ${errText}`);
        return {};
    }

    const stdoutStr = result.stdout?.toString("utf8") || "";
    if (!stdoutStr.trim()) {
        console.error("  [YF] ❌ Empty output from yf_fetch.py — no data returned");
        return {};
    }

    try {
        const data = JSON.parse(stdoutStr);
        // Top-level error from yf_fetch.py (e.g. "yfinance not installed")
        if (data && data.error && !data[tickers[0]]) {
            console.error(`  [YF] ❌ ${data.error}`);
            return {};
        }
        return data;
    } catch (e) {
        console.error(`  [YF] ❌ JSON parse error: ${e.message}`);
        console.error(`  [YF]    stdout preview: ${stdoutStr.slice(0, 200)}`);
        return {};
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY DATA FETCHERS (kept for reference — replaced by fetchAllViaYFinance)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOHLCV(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
    try {
        const r = await yfFetch(url);
        if (r.status !== 200) return null;
        const json   = JSON.parse(r.body);
        const result = json?.chart?.result?.[0];
        if (!result) return null;
        const ts  = result.timestamp || [];
        const q   = result.indicators?.quote?.[0] || {};
        const adj = result.indicators?.adjclose?.[0]?.adjclose;
        return {
            dates:   ts.map(t => new Date(t * 1000).toISOString().slice(0, 10)),
            opens:   q.open   || [],
            highs:   q.high   || [],
            lows:    q.low    || [],
            closes:  adj || q.close || [],
            volumes: q.volume || [],
            meta:    result.meta || {},
        };
    } catch (_) { return null; }
}

async function fetchAnalyst(ticker) {
    const mods = "financialData,recommendationTrend,upgradeDowngradeHistory,defaultKeyStatistics,price";
    const url  = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(mods)}`;
    try {
        const r = await yfFetch(url);
        if (r.status !== 200) return null;
        const json   = JSON.parse(r.body);
        const result = json?.quoteSummary?.result?.[0];
        if (!result) return null;

        const fd  = result.financialData         || {};
        const ks  = result.defaultKeyStatistics  || {};
        const pr  = result.price                 || {};
        const udh = result.upgradeDowngradeHistory || {};

        const cutoff  = Date.now() / 1000 - 30 * 86400;
        const recent  = (udh.history || []).filter(h => h.epochGradeDate > cutoff);
        const BULL_GRADES = ["buy","strongbuy","overweight","outperform","accumulate","positive"];
        const upgrades    = recent.filter(h =>
            ["upgraded","initiated","reiterated"].includes(h.action?.toLowerCase()) &&
            BULL_GRADES.some(g => (h.toGrade || "").toLowerCase().includes(g))
        ).length;
        const downgrades  = recent.filter(h => h.action?.toLowerCase() === "downgraded").length;

        const currentPrice = fd.currentPrice?.raw || pr.regularMarketPrice?.raw || 0;
        const targetMean   = fd.targetMeanPrice?.raw || 0;
        const targetHigh   = fd.targetHighPrice?.raw || 0;
        const upsidePct    = currentPrice > 0 && targetMean > 0
            ? (targetMean - currentPrice) / currentPrice * 100 : 0;

        return {
            currentPrice,
            targetMean,
            targetHigh,
            upsidePct,
            recommendationMean: fd.recommendationMean?.raw || 3,
            recommendationKey:  fd.recommendationKey || "hold",
            numberOfAnalysts:   fd.numberOfAnalystOpinions?.raw || 0,
            revenueGrowth:      fd.revenueGrowth?.raw  || 0,
            earningsGrowth:     fd.earningsGrowth?.raw || 0,
            grossMargins:       fd.grossMargins?.raw   || 0,
            beta:               ks.beta?.raw || pr.beta?.raw || 1,
            marketCap:          pr.marketCap?.raw || 0,
            dayChangePct:       (pr.regularMarketChangePercent?.raw || 0) * 100,
            upgrades, downgrades,
            recentHistory: recent.slice(0, 5).map(h => ({
                firm:   h.firm,
                action: h.action,
                from:   h.fromGrade,
                to:     h.toGrade,
                date:   new Date(h.epochGradeDate * 1000).toISOString().slice(0, 10),
            })),
        };
    } catch (_) { return null; }
}

async function fetchNewsRSS(ticker) {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    try {
        const r = await httpsGet(url, { "Accept": "application/rss+xml, application/xml" });
        if (r.status !== 200) return [];
        const blocks = (r.body.match(/<item>([\s\S]*?)<\/item>/gi) || []).slice(0, 8);
        return blocks.map(block => {
            const title   = ((block.match(/<title><!\[CDATA\[(.*?)\]\]>/) || block.match(/<title>(.*?)<\/title>/))?.[1] || "").trim();
            const linkRaw = (block.match(/<link>(.*?)<\/link>/)?.[1] || "").trim();
            const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "").trim();
            return title.length > 10 ? { title, url: linkRaw, pubDate } : null;
        }).filter(Boolean);
    } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICAL ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

function calcEMA(arr, n) {
    const k = 2 / (n + 1);
    let ema = null;
    return arr.map(v => {
        if (v == null) return null;
        ema = ema == null ? v : v * k + ema * (1 - k);
        return ema;
    });
}

function calcRSI(closes, n = 14) {
    const res = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return res;
    let gains = 0, losses = 0;
    for (let i = 1; i <= n; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gains += d; else losses -= d;
    }
    let ag = gains / n, al = losses / n;
    res[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (n - 1) + Math.max(d, 0)) / n;
        al = (al * (n - 1) + Math.max(-d, 0)) / n;
        res[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return res;
}

function calcMACD(closes) {
    const e12 = calcEMA(closes, 12);
    const e26 = calcEMA(closes, 26);
    const ml  = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
    const valid = ml.filter(v => v != null);
    const sg9   = calcEMA(valid, 9);
    const sl    = new Array(closes.length).fill(null);
    let j = 0;
    ml.forEach((v, i) => { if (v != null) { sl[i] = sg9[j++]; } });
    const hist = closes.map((_, i) => (ml[i] != null && sl[i] != null) ? ml[i] - sl[i] : null);
    return { ml, sl, hist };
}

function calcBB(closes, n = 20) {
    return closes.map((_, i) => {
        if (i < n - 1) return null;
        const slice = closes.slice(i - n + 1, i + 1);
        const mean  = slice.reduce((a, b) => a + b, 0) / n;
        const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
        return { upper: mean + 2 * std, lower: mean - 2 * std, mid: mean, std };
    });
}

function calcReturn(closes, bars) {
    const last  = closes[closes.length - 1];
    const start = closes[Math.max(0, closes.length - 1 - bars)];
    return (start && start > 0) ? (last - start) / start : 0;
}

function pctRank(val, arr) {
    const valid = arr.filter(v => v != null);
    if (!valid.length) return 0.5;
    const below = valid.filter(v => v <= val).length;
    return below / valid.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS SENTIMENT
// ─────────────────────────────────────────────────────────────────────────────

const BULL_KW = ["beat","beats","surge","soars","record","breakthrough","launches","partnership",
    "upgrade","raised","outperform","strong","growth","revenue","wins","contract","ai model",
    "billion","milestone","rally","bullish","expands","deal","positive","new product","jumps"];
const BEAR_KW = ["miss","misses","drops","falls","decline","cut","downgrade","loss","lawsuit",
    "delay","risk","concern","bearish","selloff","plunge","warning","investigation","fraud",
    "layoff","recall","short","negative","disappoints","retreats","stumbles"];

function scoreHeadline(title) {
    const t = title.toLowerCase();
    let s = 0;
    for (const w of BULL_KW) if (t.includes(w)) s++;
    for (const w of BEAR_KW) if (t.includes(w)) s--;
    return Math.max(-3, Math.min(3, s));
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK ANALYZER — combines all data into a single result object
// ─────────────────────────────────────────────────────────────────────────────

function analyzeStock(stock, ohlcv, analyst, news) {
    const closes  = (ohlcv?.closes  || []).filter(v => v != null && isFinite(v));
    const volumes = (ohlcv?.volumes || []).filter(v => v != null && isFinite(v));
    if (closes.length < 60) return null;

    const len = closes.length;

    // Indicators
    const ema9   = calcEMA(closes, 9);
    const ema21  = calcEMA(closes, 21);
    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const rsiArr = calcRSI(closes, 14);
    const macd   = calcMACD(closes);
    const bb     = calcBB(closes, 20);

    const last  = closes[len - 1];
    const rsi   = rsiArr[len - 1] ?? 50;
    const e9    = ema9[len - 1]   ?? last;
    const e21   = ema21[len - 1]  ?? last;
    const e50   = ema50[len - 1]  ?? last;
    const e200  = ema200[len - 1] ?? last;
    const macDl = macd.ml[len - 1]   ?? 0;
    const macSl = macd.sl[len - 1]   ?? 0;
    const bbLst = bb[len - 1]        ?? { upper: last, lower: last, mid: last, std: 0 };

    // Volume
    const vol20  = volumes.slice(-20);
    const avgVol = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 1;
    const volRat = volumes.length ? (volumes[volumes.length - 1] || 0) / avgVol : 1;

    // Returns
    const r1w = calcReturn(closes, 5);
    const r1m = calcReturn(closes, 21);
    const r2m = calcReturn(closes, 42);
    const r3m = calcReturn(closes, 63);
    const r6m = calcReturn(closes, 126);
    const r1y = calcReturn(closes, 252);

    // News sentiment
    const scoredNews = (news || []).map(a => ({ ...a, sentiment: scoreHeadline(a.title) }));
    const newsAvg    = scoredNews.length
        ? scoredNews.reduce((s, a) => s + a.sentiment, 0) / scoredNews.length : 0;
    const topStory   = scoredNews.find(a => Math.abs(a.sentiment) >= 1) || scoredNews[0] || null;

    const dayChg = analyst?.dayChangePct ?? 0;

    // Flash signals — immediate attention required
    const flash = [];
    if (dayChg >=  5) flash.push(`⚡ +${dayChg.toFixed(1)}% today`);
    if (dayChg <= -5) flash.push(`⚠️ ${dayChg.toFixed(1)}% today`);
    if ((analyst?.upgrades ?? 0) > (analyst?.downgrades ?? 0) && analyst?.upgrades > 0)
        flash.push(`🔼 ${analyst.upgrades} upgrade${analyst.upgrades > 1 ? "s" : ""} (30d)`);
    if ((analyst?.upsidePct ?? 0) >= 30) flash.push(`🎯 +${analyst.upsidePct.toFixed(0)}% to target`);
    if (r1w >= 0.08)   flash.push(`🚀 +${(r1w * 100).toFixed(1)}% this week`);
    if (newsAvg >= 1.5) flash.push("📰 Very positive news");

    return {
        ticker:  stock.ticker,
        name:    stock.name,
        sector:  stock.sector,
        price:   parseFloat(last.toFixed(2)),
        dayChg,

        tech: {
            rsi, e9, e21, e50, e200,
            macdLine: macDl, macdSig: macSl,
            macdHist: macDl - macSl,
            bbUpper: bbLst.upper, bbLower: bbLst.lower, bbMid: bbLst.mid,
            volRatio: volRat,
            aboveEma200:       last > e200,
            aboveEma50:        last > e50,
            ema9AboveEma21:    e9 > e21,
            ema50AboveEma200:  e50 > e200,
            macdBull:          macDl > macSl,
            rsiHealthy:        rsi >= 45 && rsi <= 72,
            rsiOversold:       rsi < 35,
            rsiOverbought:     rsi > 75,
            aboveBBMid:        last > bbLst.mid,
            nearBBUpper:       last > bbLst.mid + (bbLst.std * 0.8),
            volSpike:          volRat >= 1.3,
        },

        perf: { r1w, r1m, r2m, r3m, r6m, r1y },

        analyst: {
            recMean:     analyst?.recommendationMean ?? 3,
            recKey:      analyst?.recommendationKey  ?? "hold",
            upsidePct:   analyst?.upsidePct  ?? 0,
            targetMean:  analyst?.targetMean ?? 0,
            targetHigh:  analyst?.targetHigh ?? 0,
            numAnalysts: analyst?.numberOfAnalysts ?? 0,
            upgrades:    analyst?.upgrades   ?? 0,
            downgrades:  analyst?.downgrades ?? 0,
            revenueGrowthPct:  (analyst?.revenueGrowth ?? 0) * 100,
            earningsGrowthPct: (analyst?.earningsGrowth ?? 0) * 100,
            grossMarginsPct:   (analyst?.grossMargins ?? 0) * 100,
            beta:        analyst?.beta ?? 1,
            marketCapB:  (analyst?.marketCap ?? 0) / 1e9,
            history:     analyst?.recentHistory ?? [],
        },

        news: {
            items:    scoredNews.slice(0, 5),
            avgScore: parseFloat(newsAvg.toFixed(2)),
            topStory,
        },
        flash,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE  (0–100 total)
// ─────────────────────────────────────────────────────────────────────────────

function scoreStock(data, universe) {
    let score = 0;
    const signals = [];
    const { tech, perf, analyst, news } = data;

    // ── TECHNICAL (0-35) ─────────────────────────────────────────────────────
    if (tech.aboveEma200)          { score += 10; signals.push("Above EMA200 — bull trend"); }
    if (tech.ema50AboveEma200)     { score += 4;  signals.push("EMA50 > EMA200 — golden cross"); }
    if (tech.ema9AboveEma21)       { score += 5;  signals.push("EMA9 > EMA21 — short momentum"); }
    if (tech.macdBull)             { score += 6;  signals.push(`MACD bullish (hist ${tech.macdHist.toFixed(2)})`); }
    if (tech.rsiHealthy)           { score += 5;  signals.push(`RSI ${tech.rsi.toFixed(0)} — healthy uptrend`); }
    else if (tech.rsiOversold)     {              signals.push(`RSI ${tech.rsi.toFixed(0)} — oversold (watch for bounce)`); }
    else if (tech.rsiOverbought)   {              signals.push(`RSI ${tech.rsi.toFixed(0)} — overbought caution`); }
    if (tech.aboveBBMid)           { score += 3;  signals.push("Price above BB midline"); }
    if (tech.volSpike)             { score += 2;  signals.push(`Volume ${tech.volRatio.toFixed(1)}x avg`); }

    // ── PERFORMANCE RELATIVE STRENGTH (0-25) ────────────────────────────────
    const rk1m = pctRank(perf.r1m, universe.r1m);
    const rk3m = pctRank(perf.r3m, universe.r3m);
    const rk6m = pctRank(perf.r6m, universe.r6m);
    score += Math.round(rk1m * 8);
    score += Math.round(rk3m * 9);
    score += Math.round(rk6m * 8);
    if (perf.r1m > 0.05)  signals.push(`+${(perf.r1m * 100).toFixed(1)}% 1M`);
    if (perf.r3m > 0.10)  signals.push(`+${(perf.r3m * 100).toFixed(1)}% 3M`);
    if (perf.r6m > 0.15)  signals.push(`+${(perf.r6m * 100).toFixed(1)}% 6M`);
    if (perf.r1y > 0.25)  signals.push(`+${(perf.r1y * 100).toFixed(1)}% 1Y`);

    // ── MOMENTUM BONUS — stocks up ≥10% last month get a conviction boost ────
    if (perf.r1m >= 0.10) {
        score += 8;
        signals.push(`🚀 Momentum: +${(perf.r1m * 100).toFixed(1)}% last month`);
    }

    // ── ANALYST (0-25) ───────────────────────────────────────────────────────
    if      (analyst.recMean <= 1.5) { score += 15; signals.push("⭐ Strong Buy consensus"); }
    else if (analyst.recMean <= 2.0) { score += 12; signals.push("Buy consensus"); }
    else if (analyst.recMean <= 2.5) { score += 8;  signals.push("Moderate Buy consensus"); }
    else if (analyst.recMean <= 3.0) { score += 3;  signals.push("Hold consensus"); }

    if      (analyst.upsidePct >= 30) { score += 7; signals.push(`🎯 +${analyst.upsidePct.toFixed(0)}% analyst upside`); }
    else if (analyst.upsidePct >= 15) { score += 4; signals.push(`+${analyst.upsidePct.toFixed(0)}% to target`); }
    else if (analyst.upsidePct >= 5)  { score += 2; }

    if (analyst.upgrades > analyst.downgrades && analyst.upgrades > 0) {
        score += 3;
        signals.push(`${analyst.upgrades} upgrade${analyst.upgrades > 1 ? "s" : ""} this month`);
    }

    // ── SENTIMENT (0-15) ─────────────────────────────────────────────────────
    if      (news.avgScore >= 1.5) { score += 10; signals.push("Very positive news"); }
    else if (news.avgScore >= 0.5) { score += 6;  signals.push("Positive news"); }
    else if (news.avgScore >= 0)   { score += 2;  }
    else if (news.avgScore < -1)   {              signals.push("⚠️ Negative news flow"); }

    // Bonus for flash signals (catalyst)
    if (data.flash.length) score += Math.min(5, data.flash.length * 2);

    return { score: Math.min(100, Math.round(score)), signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function recLabel(mean) {
    if (mean <= 1.5) return ["STRONG BUY", "#3fb950"];
    if (mean <= 2.0) return ["BUY",        "#56d364"];
    if (mean <= 2.5) return ["MOD. BUY",   "#8bc34a"];
    if (mean <= 3.0) return ["HOLD",       "#d29922"];
    if (mean <= 3.5) return ["MOD. SELL",  "#e3823e"];
    return                  ["SELL",       "#f85149"];
}

// generateHTML removed — dashboard is now rendered by dashboard_writer.js
// The screener writes screener_results.json; dashboard_writer reads it.

function _generateHTML_removed(ranked, top5, ts) {
    const now = new Date(ts).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
    const nextRun = "Daily 9:30 AM ET";

    // ── TOP 5 CARDS ──────────────────────────────────────────────────────────
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const top5Cards = top5.map((s, i) => {
        const [recLbl, recClr] = recLabel(s.analyst.recMean);
        const uClr = s.analyst.upsidePct >= 20 ? "#3fb950" : s.analyst.upsidePct >= 5 ? "#d29922" : "#8b949e";
        const flashHtml = s.flash.map(f => `<div class="flash-item">${f}</div>`).join("");
        const topNewsHtml = s.news.topStory
            ? `<div class="news-preview">${s.news.topStory.url ? `<a href="${s.news.topStory.url}" target="_blank" rel="noopener">${s.news.topStory.title}</a>` : s.news.topStory.title}</div>`
            : "";
        const perfRow = [
            ["1M", s.perf.r1m], ["3M", s.perf.r3m], ["6M", s.perf.r6m], ["1Y", s.perf.r1y]
        ].map(([lbl, v]) => `<div class="perf-cell"><div class="perf-lbl">${lbl}</div><div class="perf-val" style="color:${clrPct(v)}">${fmtPct(v)}</div></div>`).join("");
        const topSignals = s.signals.slice(0, 4).map(sg => `<div class="signal-pill">${sg}</div>`).join("");
        const rsiBarW = Math.max(0, Math.min(100, s.tech.rsi));
        const rsiClr  = s.tech.rsi < 30 ? "#f85149" : s.tech.rsi > 70 ? "#e3823e" : "#3fb950";

        return `<div class="top-card rank-${i + 1}">
  <div class="tc-header">
    <span class="tc-medal">${medals[i]}</span>
    <div>
      <div class="tc-ticker"><a href="https://finance.yahoo.com/quote/${s.ticker}" target="_blank" rel="noopener">${s.ticker}</a></div>
      <div class="tc-name">${s.name}</div>
      <div class="tc-sector">${s.sector}</div>
    </div>
    <div class="tc-score-wrap">
      <div class="tc-score">${s.score}</div>
      <div class="tc-score-lbl">/100</div>
    </div>
  </div>
  <div class="tc-price">
    <span class="tc-price-val">$${s.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    <span class="tc-day-chg" style="color:${s.dayChg >= 0 ? "#3fb950" : "#f85149"}">${s.dayChg >= 0 ? "+" : ""}${s.dayChg.toFixed(2)}% today</span>
  </div>
  <div class="tc-rec-row">
    <span class="tc-rec-badge" style="background:${recClr}22;color:${recClr};border:1px solid ${recClr}44">${recLbl}</span>
    ${s.analyst.numAnalysts > 0 ? `<span class="tc-analysts">${s.analyst.numAnalysts} analysts</span>` : ""}
    ${s.analyst.targetMean > 0 ? `<span class="tc-target" style="color:${uClr}">Target: $${s.analyst.targetMean.toFixed(0)} <strong>(+${s.analyst.upsidePct.toFixed(0)}%)</strong></span>` : ""}
  </div>
  <div class="tc-perf">${perfRow}</div>
  <div class="rsi-wrap">
    <span class="rsi-lbl">RSI</span>
    <div class="rsi-bar"><div class="rsi-fill" style="width:${rsiBarW}%;background:${rsiClr}"></div></div>
    <span class="rsi-val" style="color:${rsiClr}">${s.tech.rsi.toFixed(0)}</span>
  </div>
  <div class="tc-signals">${topSignals}</div>
  ${flashHtml ? `<div class="tc-flash">${flashHtml}</div>` : ""}
  ${topNewsHtml}
</div>`;
    }).join("\n");

    // ── FULL TABLE ───────────────────────────────────────────────────────────
    const tableRows = ranked.map((s, i) => {
        const [recLbl, recClr] = recLabel(s.analyst.recMean);
        const top5tick = top5.map(t => t.ticker);
        const isTop5  = top5tick.includes(s.ticker);
        const rowClss = isTop5 ? "tr-top5" : "";
        return `<tr class="${rowClss}">
  <td class="td-rank">${i + 1}${isTop5 ? " ⭐" : ""}</td>
  <td class="td-ticker"><a href="https://finance.yahoo.com/quote/${s.ticker}" target="_blank" rel="noopener">${s.ticker}</a></td>
  <td>${s.name}</td>
  <td class="muted">${s.sector}</td>
  <td class="td-num">$${s.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
  <td class="td-num" style="color:${s.dayChg >= 0 ? "#3fb950" : "#f85149"}">${s.dayChg >= 0 ? "+" : ""}${s.dayChg.toFixed(1)}%</td>
  <td class="td-num" style="color:${clrPct(s.perf.r1m)}">${fmtPct(s.perf.r1m)}</td>
  <td class="td-num" style="color:${clrPct(s.perf.r2m)}">${fmtPct(s.perf.r2m)}</td>
  <td class="td-num" style="color:${clrPct(s.perf.r3m)}">${fmtPct(s.perf.r3m)}</td>
  <td class="td-num" style="color:${clrPct(s.perf.r6m)}">${fmtPct(s.perf.r6m)}</td>
  <td class="td-num" style="color:${clrPct(s.perf.r1y)}">${fmtPct(s.perf.r1y)}</td>
  <td class="td-num" style="color:${s.tech.rsi < 35 ? "#f85149" : s.tech.rsi > 70 ? "#e3823e" : "#8b949e"}">${s.tech.rsi.toFixed(0)}</td>
  <td class="td-num" style="color:${s.tech.macdBull ? "#3fb950" : "#f85149"}">${s.tech.macdBull ? "▲" : "▼"}</td>
  <td><span style="font-size:11px;font-weight:700;color:${recClr}">${recLbl}</span></td>
  <td class="td-num">${s.analyst.targetMean > 0 ? "$" + s.analyst.targetMean.toFixed(0) : "—"}</td>
  <td class="td-num" style="color:${s.analyst.upsidePct >= 20 ? "#3fb950" : s.analyst.upsidePct >= 5 ? "#d29922" : "#8b949e"}">${s.analyst.upsidePct !== 0 ? "+" + s.analyst.upsidePct.toFixed(0) + "%" : "—"}</td>
  <td><div class="score-bar-wrap"><div class="score-bar-fill" style="width:${s.score}%"></div><span class="score-val">${s.score}</span></div></td>
</tr>`;
    }).join("\n");

    // ── FLASH ALERTS ─────────────────────────────────────────────────────────
    const allFlash = ranked.filter(s => s.flash.length > 0);
    const flashSection = allFlash.length > 0
        ? `<div id="flash-bar">
  <span class="flash-label">⚡ ALERTS</span>
  ${allFlash.map(s => `<span class="flash-ticker">${s.ticker}:</span> ${s.flash.join(" &nbsp; ")}`).join(" &nbsp;&nbsp; ")}
</div>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Stock Screener</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--bull:#3fb950;--bear:#f85149;--blue:#58a6ff;--gold:#d29922;--orange:#e3823e}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5;padding-bottom:40px}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
/* HEADER */
#top-header{background:linear-gradient(135deg,#0d1117,#161b22 60%,#0d2035);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:16px}
#top-header .logo{font-size:22px;font-weight:800;color:var(--blue);letter-spacing:-.5px}
#top-header .sub{font-size:12px;color:var(--muted)}
#top-header .meta{margin-left:auto;text-align:right;font-size:12px;color:var(--muted)}
#top-header .meta strong{color:var(--text);font-size:13px}
/* FLASH BAR */
#flash-bar{background:rgba(210,153,34,.1);border-bottom:1px solid rgba(210,153,34,.3);padding:7px 24px;font-size:12px;color:var(--gold);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.flash-label{font-weight:700;margin-right:10px}
.flash-ticker{font-weight:700;color:var(--text)}
/* SECTION TITLES */
.sec-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:18px 24px 10px;font-weight:600}
/* TOP 5 GRID */
#top5-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;padding:0 24px 20px}
.top-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;position:relative;transition:border-color .2s}
.top-card:hover{border-color:var(--blue)}
.rank-1{border-top:3px solid #ffd700}
.rank-2{border-top:3px solid #c0c0c0}
.rank-3{border-top:3px solid #cd7f32}
.tc-header{display:flex;align-items:flex-start;gap:8px}
.tc-medal{font-size:20px;flex-shrink:0}
.tc-ticker{font-size:18px;font-weight:800;color:var(--blue)}
.tc-name{font-size:11px;color:var(--text);font-weight:500}
.tc-sector{font-size:10px;color:var(--muted)}
.tc-score-wrap{margin-left:auto;text-align:right;flex-shrink:0}
.tc-score{font-size:28px;font-weight:900;color:var(--bull);line-height:1}
.tc-score-lbl{font-size:10px;color:var(--muted)}
.tc-price{display:flex;align-items:baseline;gap:8px}
.tc-price-val{font-size:16px;font-weight:700}
.tc-day-chg{font-size:12px;font-weight:600}
.tc-rec-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tc-rec-badge{padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:.04em}
.tc-analysts{font-size:10px;color:var(--muted)}
.tc-target{font-size:11px;margin-left:auto}
.tc-perf{display:flex;gap:2px}
.perf-cell{flex:1;background:var(--bg3);border-radius:4px;padding:4px 3px;text-align:center}
.perf-lbl{font-size:9px;color:var(--muted);text-transform:uppercase}
.perf-val{font-size:11px;font-weight:700}
.rsi-wrap{display:flex;align-items:center;gap:6px}
.rsi-lbl{font-size:10px;color:var(--muted);width:24px}
.rsi-bar{flex:1;height:6px;background:var(--bg3);border-radius:3px;overflow:hidden}
.rsi-fill{height:100%;border-radius:3px}
.rsi-val{font-size:11px;font-weight:700;width:24px;text-align:right}
.tc-signals{display:flex;flex-wrap:wrap;gap:3px}
.signal-pill{font-size:10px;background:var(--bg3);border-radius:4px;padding:2px 6px;color:var(--muted)}
.tc-flash{display:flex;flex-wrap:wrap;gap:3px}
.flash-item{font-size:10px;font-weight:700;background:rgba(210,153,34,.12);color:var(--gold);border-radius:4px;padding:2px 6px}
.news-preview{font-size:11px;color:var(--muted);border-top:1px solid var(--border);padding-top:6px;line-height:1.4}
.news-preview a{color:var(--muted)}
.news-preview a:hover{color:var(--blue)}
/* TABLE */
#table-wrap{margin:0 24px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
thead{position:sticky;top:0;background:var(--bg3);z-index:10}
th{padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--text)}
td{padding:7px 10px;border-bottom:1px solid #1e242c;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.025)}
.tr-top5 td{background:rgba(88,166,255,.04)}
.tr-top5:hover td{background:rgba(88,166,255,.08)}
.td-rank{color:var(--muted);font-weight:600;white-space:nowrap}
.td-ticker{font-weight:700;font-size:13px}
.td-num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.score-bar-wrap{display:flex;align-items:center;gap:6px}
.score-bar-fill{height:8px;background:var(--bull);border-radius:4px;opacity:.8}
.score-val{font-size:12px;font-weight:700;min-width:24px}
/* FOOTER */
#footer{text-align:center;padding:20px;color:var(--muted);font-size:11px;margin-top:10px}
/* RESPONSIVE */
@media(max-width:1200px){#top5-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:800px){#top5-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){#top5-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<div id="top-header">
  <div>
    <div class="logo">🤖 AI Stock Screener</div>
    <div class="sub">${ranked.length} stocks analyzed → Top 5 picks filtered</div>
  </div>
  <div class="meta">
    <strong>${now}</strong><br>
    Next run: ${nextRun} &nbsp;|&nbsp; Auto-refresh: 60s
  </div>
</div>

${flashSection}

<div class="sec-title">🏆 Today's Top 5 AI Picks</div>
<div id="top5-grid">
${top5Cards}
</div>

<div class="sec-title">📊 Full AI Stock Screener — ${ranked.length} Stocks Ranked</div>
<div id="table-wrap">
<table id="screener-table">
<thead>
<tr>
  <th onclick="sortTable(0)">Rank</th>
  <th onclick="sortTable(1)">Ticker</th>
  <th onclick="sortTable(2)">Name</th>
  <th onclick="sortTable(3)">Sector</th>
  <th onclick="sortTable(4)" class="td-num">Price</th>
  <th onclick="sortTable(5)" class="td-num">1D%</th>
  <th onclick="sortTable(6)" class="td-num">1M%</th>
  <th onclick="sortTable(7)" class="td-num">2M%</th>
  <th onclick="sortTable(8)" class="td-num">3M%</th>
  <th onclick="sortTable(9)" class="td-num">6M%</th>
  <th onclick="sortTable(10)" class="td-num">1Y%</th>
  <th onclick="sortTable(11)" class="td-num">RSI</th>
  <th onclick="sortTable(12)" class="td-num">MACD</th>
  <th onclick="sortTable(13)">Consensus</th>
  <th onclick="sortTable(14)" class="td-num">Target</th>
  <th onclick="sortTable(15)" class="td-num">Upside</th>
  <th onclick="sortTable(16)">Score</th>
</tr>
</thead>
<tbody>
${tableRows}
</tbody>
</table>
</div>

<div id="footer">
  AI Stock Screener &bull; ${ranked.length} stocks &bull; Yahoo Finance data &bull; Generated ${now}<br>
  <span style="font-size:10px">For informational purposes only. Not financial advice.</span>
</div>

<script>
// Auto-refresh countdown
let countdown = 60;
setInterval(() => {
  countdown--;
  if (countdown <= 0) location.reload();
}, 1000);

// Table sort
let sortDir = {};
function sortTable(col) {
  const table = document.getElementById("screener-table");
  const rows  = Array.from(table.querySelectorAll("tbody tr"));
  sortDir[col] = !sortDir[col];
  rows.sort((a, b) => {
    const av = a.cells[col]?.textContent?.trim() || "";
    const bv = b.cells[col]?.textContent?.trim() || "";
    const an = parseFloat(av.replace(/[^0-9.\-+]/g, ""));
    const bn = parseFloat(bv.replace(/[^0-9.\-+]/g, ""));
    if (!isNaN(an) && !isNaN(bn)) return sortDir[col] ? an - bn : bn - an;
    return sortDir[col] ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  const tbody = table.querySelector("tbody");
  rows.forEach(r => tbody.appendChild(r));
}
</script>
</body>
</html>`;
// end of _generateHTML_removed
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREENER RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScreener() {
    const t0 = Date.now();
    const bar = "─".repeat(62);
    console.log(`\n${bar}`);
    console.log(`  🤖 AI STOCK SCREENER  —  ${new Date().toLocaleString()}`);
    console.log(bar);
    console.log(`  Fetching data for ${AI_STOCKS.length} AI stocks...\n`);

    // ── Fetch all data via Python yfinance (not rate-blocked like Node.js HTTP) ─
    const fetchedData = fetchAllViaYFinance(AI_STOCKS);

    // ── Diagnose any per-ticker errors before proceeding ─────────────────────
    const fetchErrors = {};
    let fetchOk = 0;
    for (const stock of AI_STOCKS) {
        const d = fetchedData[stock.ticker];
        if (!d) {
            fetchErrors[stock.ticker] = "missing from response";
        } else if (d.error) {
            fetchErrors[stock.ticker] = d.error;
        } else if (!d.ohlcv?.closes?.length) {
            fetchErrors[stock.ticker] = `no OHLCV closes (ohlcv keys: ${Object.keys(d.ohlcv || {}).join(",") || "none"})`;
        } else {
            fetchOk++;
        }
    }

    if (fetchOk === 0 && Object.keys(fetchErrors).length > 0) {
        console.log(`\n  ⚠️  ALL ${AI_STOCKS.length} stocks failed to fetch. Sample errors:`);
        Object.entries(fetchErrors).slice(0, 8).forEach(([t, e]) =>
            console.log(`    ${t.padEnd(6)} — ${String(e).slice(0, 80)}`)
        );
        // Check for common root causes
        const errSample = Object.values(fetchErrors)[0] || "";
        if (errSample.includes("No data found") || errSample.includes("empty")) {
            console.log(`\n  💡 Likely cause: Yahoo Finance is blocking requests from this IP/network.`);
            console.log(`     Try again after a few minutes, or use a VPN.`);
        } else if (errSample.includes("ConnectionError") || errSample.includes("Timeout") || errSample.includes("timeout")) {
            console.log(`\n  💡 Likely cause: Network/connectivity issue reaching Yahoo Finance.`);
        } else if (errSample.includes("yfinance")) {
            console.log(`\n  💡 Fix: pip install --upgrade yfinance`);
        }
        console.log();
    } else if (Object.keys(fetchErrors).length > 0) {
        console.log(`  [YF] ${fetchOk}/${AI_STOCKS.length} stocks fetched OK, ${Object.keys(fetchErrors).length} errors`);
    } else {
        console.log(`  [YF] All ${fetchOk} stocks fetched OK`);
    }

    const results = [];
    const failedAnalysis = [];
    process.stdout.write("  Analyzing: ");
    for (const stock of AI_STOCKS) {
        const d = fetchedData[stock.ticker];
        if (!d || d.error || !d.ohlcv?.closes?.length) {
            process.stdout.write(`${stock.ticker}(✗) `);
            continue;
        }
        const analysis = analyzeStock(stock, d.ohlcv, d.analyst, d.news);
        if (analysis) {
            results.push(analysis);
            process.stdout.write(`${stock.ticker} `);
        } else {
            failedAnalysis.push(stock.ticker);
            process.stdout.write(`${stock.ticker}(⚠) `);
        }
    }
    console.log();
    if (failedAnalysis.length > 0) {
        console.log(`  [WARN] ${failedAnalysis.length} stocks had data but <60 closes: ${failedAnalysis.join(", ")}`);
    }

    console.log();

    if (results.length === 0) {
        console.log(`${bar}`);
        console.log(`  ❌  0/${AI_STOCKS.length} stocks analyzed  |  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        console.log(`\n  ⚠️  No stocks could be analyzed. Check errors above.`);
        console.log(`\n  Common fixes:`);
        console.log(`     1. pip install --upgrade yfinance`);
        console.log(`     2. Check internet / Yahoo Finance reachability`);
        console.log(`     3. python3 yf_fetch.py NVDA  (test one stock manually)`);
        console.log(`${bar}\n`);
        return { top5: [], all: [] };
    }

    // Build relative-strength context from full universe
    const universe = {
        r1m: results.map(r => r.perf.r1m),
        r3m: results.map(r => r.perf.r3m),
        r6m: results.map(r => r.perf.r6m),
    };

    // Score and rank
    const scored = results.map(r => {
        const { score, signals } = scoreStock(r, universe);
        return { ...r, score, signals };
    }).sort((a, b) => b.score - a.score);

    const top5 = scored.slice(0, 5);

    console.log(`${"─".repeat(62)}`);
    console.log(`  ✅  ${scored.length}/${AI_STOCKS.length} stocks analyzed  |  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    console.log(`  🏆  TOP 5 PICKS:`);
    top5.forEach((s, i) => {
        const [lbl] = recLabel(s.analyst.recMean);
        console.log(`  ${i + 1}. ${s.ticker.padEnd(6)} Score:${String(s.score).padStart(3)}  ${lbl.padEnd(12)}  Target: $${s.analyst.targetMean > 0 ? s.analyst.targetMean.toFixed(0) : "—"}  (+${s.analyst.upsidePct.toFixed(0)}%)`);
        if (s.flash.length) console.log(`        ${s.flash.join("  ")}`);
    });
    console.log();

    // Write JSON (dashboard_writer.js picks this up on next trading dashboard refresh)
    const ts = new Date().toISOString();
    fs.writeFileSync(JSON_OUT, JSON.stringify({
        timestamp: ts,
        analyzed:  scored.length,
        top5: top5.map(s => ({
            ticker:     s.ticker,
            name:       s.name,
            sector:     s.sector,
            price:      s.price,
            dayChg:     parseFloat((s.dayChg || 0).toFixed(2)),
            score:      s.score,
            consensus:  s.analyst.recKey,
            recMean:    parseFloat((s.analyst.recMean || 3).toFixed(2)),
            targetMean: s.analyst.targetMean,
            upsidePct:  parseFloat(s.analyst.upsidePct.toFixed(1)),
            perf: {
                r1m: parseFloat((s.perf.r1m * 100).toFixed(1)),
                r3m: parseFloat((s.perf.r3m * 100).toFixed(1)),
                r1y: parseFloat((s.perf.r1y * 100).toFixed(1)),
            },
            signals:    s.signals.slice(0, 4),
            flash:      s.flash,
            topStory:   s.news.topStory ? { title: s.news.topStory.title, url: s.news.topStory.url || null } : null,
        })),
    }, null, 2), "utf8");

    console.log(`  Data saved → ${JSON_OUT}`);
    console.log(`  Dashboard section will update on next signal_checker poll.`);
    console.log(`${bar}\n`);

    return { top5, all: scored };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER  —  runs once at 9:00 AM local time on weekdays, then loops daily
//
// Usage modes:
//   node ai_screener.js            → run once now, exit
//   node ai_screener.js --schedule → run now + schedule daily at 9:00 AM
//   node ai_screener.js --wait     → wait for next 9:00 AM then run daily
// ─────────────────────────────────────────────────────────────────────────────

const MARKET_OPEN_HOUR   = 9;    // 9:00 AM local time (30 min before US open)
const MARKET_OPEN_MINUTE = 0;

/** Returns ms until the next weekday 9:00 AM. */
function msUntilNextRun() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(MARKET_OPEN_HOUR, MARKET_OPEN_MINUTE, 0, 0);

    // If we're already past 9:00 AM today, move to tomorrow
    if (next <= now) next.setDate(next.getDate() + 1);

    // Skip Saturday (6) and Sunday (0)
    while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
}

async function scheduledLoop(runNow = true) {
    if (runNow) {
        console.log(`[SCHEDULER] Running now — ${new Date().toLocaleString()}`);
        await runScreener().catch(e => console.error(`[SCHEDULER] Run failed: ${e.message}`));
        tryRegenerateDashboard();
    }

    while (true) {
        const ms   = msUntilNextRun();
        const next = new Date(Date.now() + ms);
        console.log(`[SCHEDULER] Next run: ${next.toLocaleString()} (in ${Math.round(ms / 60000)} min)\n`);
        await new Promise(r => setTimeout(r, ms));
        const day = new Date().getDay();
        if (day >= 1 && day <= 5) {   // Mon–Fri only
            await runScreener().catch(e => console.error(`[SCHEDULER] Run failed: ${e.message}`));
            tryRegenerateDashboard();
        }
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes("--schedule")) {
        // Run immediately, then every weekday at 9:00 AM
        scheduledLoop(true);
    } else if (args.includes("--wait")) {
        // Wait for next 9:00 AM slot, then loop daily
        scheduledLoop(false);
    } else {
        // Default: run once and exit
        runScreener().catch(err => {
            console.error("Screener failed:", err.message);
            process.exit(1);
        });
    }
}

module.exports = { runScreener };
