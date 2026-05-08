/**
 * options_checker.js  --  NDX/QQQ Options Analysis Engine  v1.1
 *
 * Fetches live QQQ options chain from Yahoo Finance (crumb auth, no API key).
 * Yahoo does NOT return Greeks -- gamma is computed via Black-Scholes from IV.
 *
 * Computes:
 *   Gamma Exposure (GEX) per strike  [pos = stabilizing, neg = trending]
 *   Key levels: Gamma Pin, Gamma Flip, Call Wall, Put Wall
 *   Max Pain (strike where option buyers lose most at expiry)
 *   Put/Call Ratio -- volume and open interest
 *   Unusual activity (vol/OI > 5x)
 *   Directional signal score (bull / bear points for prediction engine)
 *
 * Uses QQQ as the NDX proxy (most liquid, best options data).
 * No npm dependencies -- pure Node.js.
 */

"use strict";

const https = require("https");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const OPTIONS_SYMBOL  = process.env.OPTIONS_SYMBOL || "QQQ";
const RISK_FREE_RATE  = 0.045;   // ~3-month T-bill rate
const CONTRACT_SIZE   = 100;     // standard US equity options multiplier
const UNUSUAL_RATIO   = 5;       // vol/OI ratio threshold for unusual activity
const UNUSUAL_MIN_VOL = 50;      // minimum volume to flag as unusual
const WALL_PROX_PCT   = 0.008;   // within 0.8% = "near wall"
const CRUMB_TTL_MS    = 2 * 60 * 60 * 1000;  // reuse crumb for 2 hours

// ── CRUMB CACHE ───────────────────────────────────────────────────────────────
let _crumbCache = null;  // { crumb, cookies, ts }

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 -- BLACK-SCHOLES MATH
// ─────────────────────────────────────────────────────────────────────────────

function normPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz and Stegun approximation for normal CDF */
function normCDF(x) {
    const neg = x < 0;
    const z = Math.abs(x);
    const t = 1 / (1 + 0.2316419 * z);
    const d = 0.3989422820 * Math.exp(-0.5 * z * z);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return neg ? p : 1 - p;
}

/**
 * Black-Scholes Gamma: phi(d1) / (S * sigma * sqrt(T))
 * S=spot, K=strike, T=years to expiry, r=risk-free rate, sigma=annualised IV
 */
function bsGamma(S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
    const sqrtT = Math.sqrt(T);
    const d1    = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    return normPDF(d1) / (S * sigma * sqrtT);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 -- YAHOO FINANCE CRUMB AUTH
// ─────────────────────────────────────────────────────────────────────────────

function httpsGet(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
        });
        req.on("error", reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout: ${hostname}${path}`)); });
        req.end();
    });
}

/** Obtain crumb + cookies (cached for CRUMB_TTL_MS). */
async function getCrumb() {
    if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL_MS) {
        return _crumbCache;
    }

    // 1. Hit a Yahoo Finance quote page to receive the session cookie
    const page = await httpsGet(
        "finance.yahoo.com",
        `/quote/${OPTIONS_SYMBOL}`,
        { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
    );
    const rawCookies = page.headers["set-cookie"] || [];
    const cookies    = rawCookies.map(c => c.split(";")[0]).join("; ");

    if (!cookies) throw new Error("Could not obtain Yahoo Finance session cookies");

    // 2. Exchange cookie for a crumb
    const crumbResp = await httpsGet(
        "query1.finance.yahoo.com",
        "/v1/test/getcrumb",
        { "User-Agent": "Mozilla/5.0", "Cookie": cookies }
    );

    const crumb = crumbResp.body.trim();
    if (!crumb || crumb.length > 20) throw new Error(`Unexpected crumb response: ${crumb.slice(0, 50)}`);

    _crumbCache = { crumb, cookies, ts: Date.now() };
    return _crumbCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 -- OPTIONS CHAIN FETCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the nearest-expiry options chain for a given symbol (or OPTIONS_SYMBOL).
 * Returns the raw result[0] object from Yahoo Finance v7.
 */
async function fetchOptionsChain(sym) {
    const symbol = sym || OPTIONS_SYMBOL;
    const { crumb, cookies } = await getCrumb();
    const path  = `/v7/finance/options/${symbol}?crumb=${encodeURIComponent(crumb)}`;
    const resp  = await httpsGet("query1.finance.yahoo.com", path, {
        "User-Agent": "Mozilla/5.0",
        "Cookie":     cookies,
    });

    if (resp.status === 401) {
        // Crumb expired -- clear cache and retry once
        _crumbCache = null;
        return fetchOptionsChain(sym);
    }

    let json;
    try { json = JSON.parse(resp.body); } catch (e) { throw new Error("Options JSON parse error"); }

    const result = json.optionChain?.result?.[0];
    if (!result) throw new Error("No options chain data: " + JSON.stringify(json.optionChain?.error || {}));
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 -- GAMMA EXPOSURE (GEX) PROFILE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build GEX profile from one expiry's options data.
 *
 * Dealer convention (market makers are usually net short options to clients):
 *   Dealers sold calls  -> they are LONG delta, LONG gamma on calls
 *     Call GEX = +gamma * OI * CONTRACT_SIZE * spot
 *   Dealers sold puts   -> they are SHORT delta, LONG gamma on puts  (puts have negative delta)
 *     Put GEX  = -gamma * OI * CONTRACT_SIZE * spot  (negative contribution)
 *   Net GEX at K = callGEX - putGEX
 *
 *   Positive net GEX  -> dealers long gamma -> they hedge by selling rallies / buying dips  (stabilising)
 *   Negative net GEX  -> dealers short gamma -> they hedge by buying rallies / selling dips  (amplifying)
 */
function buildGEXProfile(options, spotPrice) {
    const calls = options.calls || [];
    const puts  = options.puts  || [];

    const msToExpiry = (options.expirationDate * 1000) - Date.now();
    const T          = Math.max(msToExpiry / (365.25 * 24 * 3600 * 1000), 1 / 365);  // min 1 day

    const map = {};
    const ensure = (K) => {
        if (!map[K]) map[K] = { callGEX: 0, putGEX: 0, netGEX: 0, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callIV: 0, putIV: 0, callGamma: 0, putGamma: 0 };
    };

    for (const c of calls) {
        const K     = c.strike;
        const oi    = c.openInterest    || 0;
        const iv    = c.impliedVolatility > 0 ? c.impliedVolatility : 0.25;
        const gamma = bsGamma(spotPrice, K, T, RISK_FREE_RATE, iv);
        ensure(K);
        map[K].callGEX   += gamma * oi * CONTRACT_SIZE * spotPrice;
        map[K].callOI    += oi;
        map[K].callVol   += c.volume || 0;
        map[K].callIV     = iv;
        map[K].callGamma  = gamma;
    }

    for (const p of puts) {
        const K     = p.strike;
        const oi    = p.openInterest    || 0;
        const iv    = p.impliedVolatility > 0 ? p.impliedVolatility : 0.25;
        const gamma = bsGamma(spotPrice, K, T, RISK_FREE_RATE, iv);
        ensure(K);
        map[K].putGEX   += gamma * oi * CONTRACT_SIZE * spotPrice;
        map[K].putOI    += oi;
        map[K].putVol   += p.volume || 0;
        map[K].putIV     = iv;
        map[K].putGamma  = gamma;
    }

    for (const K of Object.keys(map)) {
        map[K].netGEX = map[K].callGEX - map[K].putGEX;
    }
    return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 -- KEY GAMMA LEVELS
// ─────────────────────────────────────────────────────────────────────────────

function findKeyLevels(gexMap, spotPrice) {
    const strikes = Object.keys(gexMap).map(Number).sort((a, b) => a - b);
    if (!strikes.length) return { gammaPin: null, gammaFlip: null, callWall: null, putWall: null, totalGEX: 0, posGEX: true, topGEX: [] };

    // Gamma Pin -- strike with highest absolute net GEX
    let gammaPin = strikes[0];
    for (const K of strikes) {
        if (Math.abs(gexMap[K].netGEX) > Math.abs(gexMap[gammaPin].netGEX)) gammaPin = K;
    }

    // Gamma Flip -- cumulative GEX sign change
    let cumGEX = 0, gammaFlip = null;
    for (const K of strikes) {
        const prev = cumGEX;
        cumGEX += gexMap[K].netGEX;
        if (prev !== 0 && ((prev < 0 && cumGEX >= 0) || (prev > 0 && cumGEX <= 0))) {
            gammaFlip = K;
        }
    }

    // Total GEX
    const totalGEX = strikes.reduce((s, K) => s + gexMap[K].netGEX, 0);

    // Call Wall -- highest call OI above spot (resistance)
    const aboveSpot = strikes.filter(K => K > spotPrice);
    let callWall = aboveSpot[0] ?? null;
    for (const K of aboveSpot) {
        if (gexMap[K].callOI > (gexMap[callWall]?.callOI ?? 0)) callWall = K;
    }

    // Put Wall -- highest put OI below spot (support)
    const belowSpot = strikes.filter(K => K < spotPrice);
    let putWall = belowSpot[belowSpot.length - 1] ?? null;
    for (const K of belowSpot) {
        if (gexMap[K].putOI > (gexMap[putWall]?.putOI ?? 0)) putWall = K;
    }

    // Top 5 GEX strikes for display
    const topGEX = [...strikes]
        .sort((a, b) => Math.abs(gexMap[b].netGEX) - Math.abs(gexMap[a].netGEX))
        .slice(0, 5)
        .map(K => ({ strike: K, netGEX: gexMap[K].netGEX, callOI: gexMap[K].callOI, putOI: gexMap[K].putOI }));

    return { gammaPin, gammaFlip, callWall, putWall, totalGEX, posGEX: totalGEX >= 0, topGEX };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 -- MAX PAIN
// ─────────────────────────────────────────────────────────────────────────────

function calculateMaxPain(options) {
    const calls   = options.calls || [];
    const puts    = options.puts  || [];
    const strikes = [...new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)])].sort((a, b) => a - b);
    if (!strikes.length) return null;

    let minPain = Infinity, maxPainStrike = strikes[0];
    for (const testK of strikes) {
        let pain = 0;
        for (const c of calls)  pain += Math.max(0, testK - c.strike) * (c.openInterest || 0) * CONTRACT_SIZE;
        for (const p of puts)   pain += Math.max(0, p.strike - testK) * (p.openInterest || 0) * CONTRACT_SIZE;
        if (pain < minPain) { minPain = pain; maxPainStrike = testK; }
    }
    return maxPainStrike;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 -- OPTIONS FLOW ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

function analyzeOptionsFlow(options) {
    const calls = options.calls || [];
    const puts  = options.puts  || [];

    const totalCallVol = calls.reduce((s, c) => s + (c.volume || 0), 0);
    const totalPutVol  = puts.reduce( (s, p) => s + (p.volume || 0), 0);
    const totalCallOI  = calls.reduce((s, c) => s + (c.openInterest || 0), 0);
    const totalPutOI   = puts.reduce( (s, p) => s + (p.openInterest || 0), 0);

    const pcrVolume = totalCallVol > 0 ? +(totalPutVol  / totalCallVol).toFixed(2) : 1.0;
    const pcrOI     = totalCallOI  > 0 ? +(totalPutOI   / totalCallOI ).toFixed(2) : 1.0;

    const enrich = (o, side) => ({
        strike:        o.strike,
        volume:        o.volume        || 0,
        openInterest:  o.openInterest  || 0,
        iv:            +((o.impliedVolatility || 0) * 100).toFixed(1),
        ratio:         o.openInterest  > 0 ? +((o.volume || 0) / o.openInterest).toFixed(1) : 0,
        inTheMoney:    o.inTheMoney    || false,
        bid:           o.bid           || 0,
        ask:           o.ask           || 0,
    });

    // Unusual activity: vol/OI > UNUSUAL_RATIO and minimum volume
    const unusualCalls = calls
        .filter(c => c.openInterest > 0 && (c.volume || 0) >= UNUSUAL_MIN_VOL && (c.volume / c.openInterest) >= UNUSUAL_RATIO)
        .sort((a, b) => (b.volume / b.openInterest) - (a.volume / a.openInterest))
        .slice(0, 5).map(o => enrich(o));

    const unusualPuts = puts
        .filter(p => p.openInterest > 0 && (p.volume || 0) >= UNUSUAL_MIN_VOL && (p.volume / p.openInterest) >= UNUSUAL_RATIO)
        .sort((a, b) => (b.volume / b.openInterest) - (a.volume / a.openInterest))
        .slice(0, 5).map(o => enrich(o));

    // Top by volume (today's flow)
    const topCallsByVol = [...calls].filter(c => (c.volume || 0) > 0)
        .sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5).map(o => enrich(o));
    const topPutsByVol  = [...puts].filter(p => (p.volume || 0) > 0)
        .sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5).map(o => enrich(o));

    // Top by OI (big positioning)
    const topCallsByOI = [...calls].sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5).map(o => enrich(o));
    const topPutsByOI  = [...puts].sort( (a, b) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5).map(o => enrich(o));

    return { totalCallVol, totalPutVol, totalCallOI, totalPutOI, pcrVolume, pcrOI,
             unusualCalls, unusualPuts, topCallsByVol, topPutsByVol, topCallsByOI, topPutsByOI };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 -- SIGNAL SCORING  (plugs into predictNextCandle in signal_checker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score options analysis for prediction engine.
 * Returns { bull, bear, reasons } -- max 4 points per direction.
 *
 *   +1  Gamma regime: above flip = bull, below flip = bear
 *   +1  Wall proximity: near put wall (support) or call wall (resistance)
 *   +1  PCR flow interpretation
 *   +1  Unusual activity direction
 */
function scoreOptionsSignal(levels, flow, spotPrice) {
    let bull = 0, bear = 0;
    const reasons = [];

    const gexSign = levels.totalGEX >= 0 ? "+" : "";
    reasons.push(`GEX ${gexSign}${(levels.totalGEX / 1e6).toFixed(1)}M (${levels.posGEX ? "POSITIVE-stabilizing" : "NEGATIVE-trending"})`);

    if (levels.gammaFlip !== null) {
        if (spotPrice > levels.gammaFlip) { bull += 1; reasons.push(`Above gamma flip $${levels.gammaFlip} (bull regime)`); }
        else                              { bear += 1; reasons.push(`Below gamma flip $${levels.gammaFlip} (bear regime)`); }
    }

    if (levels.putWall  !== null && (spotPrice - levels.putWall)  / spotPrice <= WALL_PROX_PCT) { bull += 1; reasons.push(`At put wall support $${levels.putWall}`); }
    if (levels.callWall !== null && (levels.callWall - spotPrice) / spotPrice <= WALL_PROX_PCT) { bear += 1; reasons.push(`At call wall resistance $${levels.callWall}`); }

    if      (flow.pcrVolume > 1.5) { bull += 1; reasons.push(`PCR ${flow.pcrVolume} -- extreme puts (contrarian bull)`); }
    else if (flow.pcrVolume > 1.1) { bear += 1; reasons.push(`PCR ${flow.pcrVolume} -- elevated put flow (bearish)`); }
    else if (flow.pcrVolume < 0.5) { bear += 1; reasons.push(`PCR ${flow.pcrVolume} -- extreme calls (contrarian bear)`); }
    else if (flow.pcrVolume < 0.8) { bull += 1; reasons.push(`PCR ${flow.pcrVolume} -- bullish options flow`); }

    const uc = flow.unusualCalls.length, up = flow.unusualPuts.length;
    if (uc > up && uc > 0) { bull += 1; reasons.push(`Unusual call flow: ${uc} strike(s) vol/OI > ${UNUSUAL_RATIO}x`); }
    if (up > uc && up > 0) { bear += 1; reasons.push(`Unusual put flow: ${up} strike(s) vol/OI > ${UNUSUAL_RATIO}x`); }

    return { bull, bear, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 -- MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze options chain for any symbol (e.g. "QQQ" for NDX, "SPY" for SPX).
 * @param {string} symbol   - Options ticker to fetch (default: OPTIONS_SYMBOL env var)
 * @param {number} fallbackSpot - Price fallback if Yahoo quote is missing
 */
async function analyzeOptionsFor(symbol, fallbackSpot) {
    const sym     = symbol || OPTIONS_SYMBOL;
    const chain   = await fetchOptionsChain(sym);
    const spot    = chain.quote?.regularMarketPrice || fallbackSpot || 0;
    const options = chain.options?.[0];
    if (!options) throw new Error("No options expiry data");

    const expDate = new Date(options.expirationDate * 1000);
    const expiry  = expDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const dte     = Math.ceil((options.expirationDate * 1000 - Date.now()) / 86400000);

    const gexMap  = buildGEXProfile(options, spot);
    const levels  = findKeyLevels(gexMap, spot);
    const flow    = analyzeOptionsFlow(options);
    const maxPain = calculateMaxPain(options);
    const score   = scoreOptionsSignal(levels, flow, spot);

    return { symbol: sym, spotPrice: spot, expiry, dte, levels, flow, maxPain, score,
             rawChain: { calls: options.calls || [], puts: options.puts || [], expirationDate: options.expirationDate } };
}

/** Backward-compatible wrapper using the OPTIONS_SYMBOL env var. */
async function analyzeOptions(fallbackSpot) {
    return analyzeOptionsFor(OPTIONS_SYMBOL, fallbackSpot);
}

module.exports = { analyzeOptions, analyzeOptionsFor };

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 -- STANDALONE CONSOLE OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

const $ = (n) => n != null ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "N/A";
const K = (n) => n != null ? (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n)) : "0";

if (require.main === module) {
    console.log(`\nOptions Analysis -- ${OPTIONS_SYMBOL} (NDX proxy)`);
    console.log("=".repeat(62));

    analyzeOptions(0).then(r => {
        console.log(`\n  Underlying : ${r.symbol}   Spot : ${$(r.spotPrice)}`);
        console.log(`  Expiry     : ${r.expiry}  (${r.dte} DTE)\n`);

        // Gamma levels
        console.log(`  -- GAMMA LEVELS --`);
        const gexM   = (r.levels.totalGEX / 1e6).toFixed(1);
        const regime = r.levels.posGEX ? "POSITIVE (stabilizing)" : "NEGATIVE (trending/volatile)";
        console.log(`  Total GEX  : ${gexM}M  [${regime}]`);
        console.log(`  Gamma Pin  : ${$(r.levels.gammaPin)}   (highest GEX concentration -- price magnet)`);
        console.log(`  Gamma Flip : ${$(r.levels.gammaFlip)}   (above=bull regime / below=bear regime)`);
        console.log(`  Call Wall  : ${$(r.levels.callWall)}   (resistance -- highest call OI above spot)`);
        console.log(`  Put Wall   : ${$(r.levels.putWall)}   (support  -- highest put OI below spot)`);
        console.log(`  Max Pain   : ${$(r.maxPain)}`);

        if (r.levels.topGEX?.length) {
            console.log(`\n  Top GEX Strikes:`);
            for (const g of r.levels.topGEX) {
                const sign = g.netGEX >= 0 ? "+" : "";
                console.log(`    ${$(g.strike).padEnd(10)}  net: ${sign}${(g.netGEX / 1e6).toFixed(2)}M   callOI: ${K(g.callOI)}   putOI: ${K(g.putOI)}`);
            }
        }

        // Flow
        console.log(`\n  -- OPTIONS FLOW --`);
        console.log(`  PCR Vol : ${r.flow.pcrVolume}   PCR OI : ${r.flow.pcrOI}`);
        console.log(`  Calls   : vol ${r.flow.totalCallVol.toLocaleString().padEnd(8)} OI ${r.flow.totalCallOI.toLocaleString()}`);
        console.log(`  Puts    : vol ${r.flow.totalPutVol.toLocaleString().padEnd(8)} OI ${r.flow.totalPutOI.toLocaleString()}`);

        console.log(`\n  Top Calls by Volume:`);
        for (const c of r.flow.topCallsByVol)
            console.log(`    ${$(c.strike).padEnd(10)} vol: ${String(c.volume).padEnd(7)} OI: ${String(c.openInterest).padEnd(7)} IV: ${c.iv}%  ${c.inTheMoney ? "[ITM]" : ""}`);

        console.log(`\n  Top Puts by Volume:`);
        for (const p of r.flow.topPutsByVol)
            console.log(`    ${$(p.strike).padEnd(10)} vol: ${String(p.volume).padEnd(7)} OI: ${String(p.openInterest).padEnd(7)} IV: ${p.iv}%  ${p.inTheMoney ? "[ITM]" : ""}`);

        if (r.flow.unusualCalls.length) {
            console.log(`\n  *** UNUSUAL CALL ACTIVITY (vol/OI > ${UNUSUAL_RATIO}x) ***`);
            for (const c of r.flow.unusualCalls)
                console.log(`    ${$(c.strike).padEnd(10)} vol: ${String(c.volume).padEnd(7)} OI: ${String(c.openInterest).padEnd(7)} ratio: ${c.ratio}x  IV: ${c.iv}%`);
        }
        if (r.flow.unusualPuts.length) {
            console.log(`\n  *** UNUSUAL PUT ACTIVITY (vol/OI > ${UNUSUAL_RATIO}x) ***`);
            for (const p of r.flow.unusualPuts)
                console.log(`    ${$(p.strike).padEnd(10)} vol: ${String(p.volume).padEnd(7)} OI: ${String(p.openInterest).padEnd(7)} ratio: ${p.ratio}x  IV: ${p.iv}%`);
        }

        // Signal score
        console.log(`\n  -- SIGNAL SCORE --`);
        console.log(`  Bull: ${r.score.bull}   Bear: ${r.score.bear}`);
        for (const reason of r.score.reasons) console.log(`    * ${reason}`);

        console.log(`\n${"=".repeat(62)}`);
    }).catch(err => console.error(`\nOptions error: ${err.message}`));
}
