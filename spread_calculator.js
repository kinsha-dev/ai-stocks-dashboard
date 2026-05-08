/**
 * spread_calculator.js  --  Options Spread Strategy Selector v2.0
 *
 * Evaluates the four directional spread strategies (no Iron Condor)
 * and returns a SINGLE clear recommendation — either credit or debit —
 * based on IV level, DTE, and prediction bias.
 *
 * Strategies:
 *   Bull Call Spread  (debit)  -- BULL + low IV / long DTE
 *   Bull Put Spread   (credit) -- BULL + high IV / short DTE
 *   Bear Put Spread   (debit)  -- BEAR + low IV / long DTE
 *   Bear Call Spread  (credit) -- BEAR + high IV / short DTE
 *   Long Straddle     (debit)  -- negative GEX / explosive vol expected
 *
 * Each result includes a targetPrice (strike for max profit) and a
 * trendLabel ("▲ BULL" / "▼ BEAR" / "⚡ VOLATILE") for dashboard display.
 *
 * Export: recommendSpread(optionsData, prediction) -> SpreadResult | null
 */

"use strict";

const RISK_FREE_RATE  = 0.045;   // ~current 3-month T-bill
const CONTRACT_SIZE   = 100;     // standard US equity options multiplier
const HIGH_IV_THRESH  = 0.30;    // ATM IV above this → prefer credit spreads
const SHORT_DTE_THRESH = 3;      // DTE at or below this → prefer credit spreads

// ── BLACK-SCHOLES MATH ────────────────────────────────────────────────────────

function normPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCDF(x) {
    const neg = x < 0;
    const z   = Math.abs(x);
    const t   = 1 / (1 + 0.2316419 * z);
    const d   = 0.3989422820 * Math.exp(-0.5 * z * z);
    const p   = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return neg ? p : 1 - p;
}

function bsD1(S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
    return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function bsPrice(S, K, T, r, sigma, type) {
    if (T <= 0 || sigma <= 0) {
        return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    }
    const d1 = bsD1(S, K, T, r, sigma);
    const d2 = d1 - sigma * Math.sqrt(T);
    if (type === "call") return Math.max(0, S * normCDF(d1)  - K * Math.exp(-r * T) * normCDF(d2));
    return Math.max(0, K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1));
}

function bsDelta(S, K, T, r, sigma, type) {
    if (T <= 0 || sigma <= 0) return type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    const d1 = bsD1(S, K, T, r, sigma);
    return type === "call" ? normCDF(d1) : normCDF(d1) - 1;
}

function probITM(S, K, T, r, sigma, type) {
    if (T <= 0 || sigma <= 0) return S > K ? 1 : 0;
    const d1 = bsD1(S, K, T, r, sigma);
    const d2 = d1 - sigma * Math.sqrt(T);
    return type === "call" ? normCDF(d2) : normCDF(-d2);
}

// ── CHAIN HELPERS ─────────────────────────────────────────────────────────────

// Minimum sensible IV to prevent near-zero debit / absurd R/R from bad Yahoo Finance data
const MIN_IV = 0.05;  // 5% floor — below this Yahoo Finance data is unreliable

function getIV(chainArr, strike, fallback = 0.25) {
    const opt = chainArr.find(o => o.strike === strike);
    const raw = (opt && opt.impliedVolatility > 0) ? opt.impliedVolatility : fallback;
    return Math.max(MIN_IV, raw);
}

function atmIV(chainArr, spot) {
    const sorted = [...chainArr].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const atm    = sorted.slice(0, 3);
    if (!atm.length) return 0.25;
    const ivs = atm.map(o => o.impliedVolatility || 0.25).filter(v => v > MIN_IV);
    // If all ATM IVs are below the floor (bad data), use fallback
    if (!ivs.length) return 0.25;
    const avg = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    return Math.max(MIN_IV, avg);
}

function findStrike(chainArr, target, direction = "nearest") {
    const strikes = [...new Set(chainArr.map(o => o.strike))].sort((a, b) => a - b);
    if (!strikes.length) return target;
    if (direction === "nearest") return strikes.reduce((best, k) => Math.abs(k - target) < Math.abs(best - target) ? k : best, strikes[0]);
    if (direction === "above")   return strikes.find(k => k >= target) ?? strikes[strikes.length - 1];
    return [...strikes].reverse().find(k => k <= target) ?? strikes[0];
}

function autoWidth(spot) {
    const snapped = Math.round(spot * 0.015 / 0.5) * 0.5;
    return Math.max(1.0, snapped);
}

// ── DEBIT SPREADS ─────────────────────────────────────────────────────────────

/**
 * Bull Call Spread — BUY ATM call + SELL OTM call.
 * Debit trade. Best when: BULL bias, low IV, DTE ≥ 7.
 * Target price = short call strike (max profit if price ≥ that at expiry).
 */
function buildBullCallSpread(calls, S, T, width) {
    const buyStrike  = findStrike(calls, S, "nearest");
    const sellStrike = findStrike(calls, buyStrike + width, "above");
    if (buyStrike === sellStrike) return null;

    const buyIV  = getIV(calls, buyStrike,  atmIV(calls, S));
    const sellIV = getIV(calls, sellStrike, buyIV);

    const buyP  = bsPrice(S, buyStrike,  T, RISK_FREE_RATE, buyIV,  "call");
    const sellP = bsPrice(S, sellStrike, T, RISK_FREE_RATE, sellIV, "call");

    const debit      = parseFloat((buyP - sellP).toFixed(2));
    const width_     = sellStrike - buyStrike;
    // Sanity: debit must be at least 2% of spread width; if not, chain data is bad
    if (debit < width_ * 0.02 || debit <= 0) return null;
    const maxProfit  = Math.round((width_ - debit) * CONTRACT_SIZE);
    const maxLoss    = Math.round(debit * CONTRACT_SIZE);
    const rr         = maxLoss > 0 ? parseFloat((maxProfit / maxLoss).toFixed(2)) : 0;
    const breakEven  = parseFloat((buyStrike + debit).toFixed(2));
    const pop        = parseFloat((probITM(S, breakEven, T, RISK_FREE_RATE, buyIV, "call") * 100).toFixed(1));

    return {
        strategy:    "Bull Call Spread",
        direction:   "BULL",
        type:        "debit",
        trendLabel:  "▲ BULL",
        legs: [
            { action: "BUY",  type: "CALL", strike: buyStrike,  iv: +((buyIV  * 100).toFixed(1)), theorPrice: +(buyP.toFixed(2)),  delta: +(bsDelta(S, buyStrike,  T, RISK_FREE_RATE, buyIV,  "call").toFixed(2)) },
            { action: "SELL", type: "CALL", strike: sellStrike, iv: +((sellIV * 100).toFixed(1)), theorPrice: +(sellP.toFixed(2)), delta: +(bsDelta(S, sellStrike, T, RISK_FREE_RATE, sellIV, "call").toFixed(2)) },
        ],
        netDebit:     debit,
        spreadWidth:  width_,
        maxProfit,
        maxLoss,
        riskReward:   rr,
        breakEven,
        probOfProfit: pop,
        targetPrice:  sellStrike,
        targetNote:   `▲ Max profit if price reaches $${sellStrike} (short call strike)`,
    };
}

/**
 * Bear Put Spread — BUY ATM put + SELL OTM put.
 * Debit trade. Best when: BEAR bias, low IV, DTE ≥ 7.
 * Target price = short put strike (max profit if price ≤ that at expiry).
 */
function buildBearPutSpread(puts, S, T, width) {
    const buyStrike  = findStrike(puts, S, "nearest");
    const sellStrike = findStrike(puts, buyStrike - width, "below");
    if (buyStrike === sellStrike) return null;

    const buyIV  = getIV(puts, buyStrike,  atmIV(puts, S));
    const sellIV = getIV(puts, sellStrike, buyIV);

    const buyP  = bsPrice(S, buyStrike,  T, RISK_FREE_RATE, buyIV,  "put");
    const sellP = bsPrice(S, sellStrike, T, RISK_FREE_RATE, sellIV, "put");

    const debit      = parseFloat((buyP - sellP).toFixed(2));
    const width_     = buyStrike - sellStrike;
    // Sanity: debit must be at least 2% of spread width; if not, chain data is bad
    if (debit < width_ * 0.02 || debit <= 0) return null;
    const maxProfit  = Math.round((width_ - debit) * CONTRACT_SIZE);
    const maxLoss    = Math.round(debit * CONTRACT_SIZE);
    const rr         = maxLoss > 0 ? parseFloat((maxProfit / maxLoss).toFixed(2)) : 0;
    const breakEven  = parseFloat((buyStrike - debit).toFixed(2));
    const pop        = parseFloat((probITM(S, breakEven, T, RISK_FREE_RATE, buyIV, "put") * 100).toFixed(1));

    return {
        strategy:    "Bear Put Spread",
        direction:   "BEAR",
        type:        "debit",
        trendLabel:  "▼ BEAR",
        legs: [
            { action: "BUY",  type: "PUT", strike: buyStrike,  iv: +((buyIV  * 100).toFixed(1)), theorPrice: +(buyP.toFixed(2)),  delta: +(bsDelta(S, buyStrike,  T, RISK_FREE_RATE, buyIV,  "put").toFixed(2)) },
            { action: "SELL", type: "PUT", strike: sellStrike, iv: +((sellIV * 100).toFixed(1)), theorPrice: +(sellP.toFixed(2)), delta: +(bsDelta(S, sellStrike, T, RISK_FREE_RATE, sellIV, "put").toFixed(2)) },
        ],
        netDebit:     debit,
        spreadWidth:  width_,
        maxProfit,
        maxLoss,
        riskReward:   rr,
        breakEven,
        probOfProfit: pop,
        targetPrice:  sellStrike,
        targetNote:   `▼ Max profit if price falls to $${sellStrike} (short put strike)`,
    };
}

// ── CREDIT SPREADS ────────────────────────────────────────────────────────────

/**
 * Bull Put Spread — SELL OTM put + BUY further OTM put.
 * Credit trade. Best when: BULL bias, high IV, short DTE.
 * Target price = short put strike (collect full credit if price stays above it).
 */
function buildBullPutSpread(puts, S, T, width) {
    // Short put ~1% below spot (OTM but close), long put further below
    const shortStrike = findStrike(puts, S * 0.990, "below");
    const longStrike  = findStrike(puts, shortStrike - width, "below");
    if (shortStrike === longStrike || shortStrike >= S) return null;

    const shortIV = getIV(puts, shortStrike, atmIV(puts, S));
    const longIV  = getIV(puts, longStrike,  shortIV);

    const shortP  = bsPrice(S, shortStrike, T, RISK_FREE_RATE, shortIV, "put");
    const longP   = bsPrice(S, longStrike,  T, RISK_FREE_RATE, longIV,  "put");

    const credit     = parseFloat((shortP - longP).toFixed(2));
    if (credit <= 0) return null;
    const width_     = shortStrike - longStrike;
    const maxProfit  = Math.round(credit * CONTRACT_SIZE);
    const maxLoss    = Math.round((width_ - credit) * CONTRACT_SIZE);
    const rr         = maxLoss > 0 ? parseFloat((maxProfit / maxLoss).toFixed(2)) : 0;
    const breakEven  = parseFloat((shortStrike - credit).toFixed(2));
    // PoP = probability that price stays above break-even
    const pop        = parseFloat(((1 - probITM(S, breakEven, T, RISK_FREE_RATE, shortIV, "put")) * 100).toFixed(1));

    return {
        strategy:    "Bull Put Spread",
        direction:   "BULL",
        type:        "credit",
        trendLabel:  "▲ BULL",
        legs: [
            { action: "SELL", type: "PUT", strike: shortStrike, iv: +((shortIV * 100).toFixed(1)), theorPrice: +(shortP.toFixed(2)), delta: +(bsDelta(S, shortStrike, T, RISK_FREE_RATE, shortIV, "put").toFixed(2)) },
            { action: "BUY",  type: "PUT", strike: longStrike,  iv: +((longIV  * 100).toFixed(1)), theorPrice: +(longP.toFixed(2)),  delta: +(bsDelta(S, longStrike,  T, RISK_FREE_RATE, longIV,  "put").toFixed(2)) },
        ],
        netCredit:    credit,
        spreadWidth:  width_,
        maxProfit,
        maxLoss,
        riskReward:   rr,
        breakEven,
        profitZone:   `Above $${breakEven}`,
        probOfProfit: pop,
        targetPrice:  shortStrike,
        targetNote:   `▲ Full credit kept if price stays above $${shortStrike} at expiry`,
    };
}

/**
 * Bear Call Spread — SELL OTM call + BUY further OTM call.
 * Credit trade. Best when: BEAR bias, high IV, short DTE.
 * Target price = short call strike (collect full credit if price stays below it).
 */
function buildBearCallSpread(calls, S, T, width) {
    // Short call ~1% above spot (OTM but close), long call further above
    const shortStrike = findStrike(calls, S * 1.010, "above");
    const longStrike  = findStrike(calls, shortStrike + width, "above");
    if (shortStrike === longStrike || shortStrike <= S) return null;

    const shortIV = getIV(calls, shortStrike, atmIV(calls, S));
    const longIV  = getIV(calls, longStrike,  shortIV);

    const shortP  = bsPrice(S, shortStrike, T, RISK_FREE_RATE, shortIV, "call");
    const longP   = bsPrice(S, longStrike,  T, RISK_FREE_RATE, longIV,  "call");

    const credit     = parseFloat((shortP - longP).toFixed(2));
    if (credit <= 0) return null;
    const width_     = longStrike - shortStrike;
    const maxProfit  = Math.round(credit * CONTRACT_SIZE);
    const maxLoss    = Math.round((width_ - credit) * CONTRACT_SIZE);
    const rr         = maxLoss > 0 ? parseFloat((maxProfit / maxLoss).toFixed(2)) : 0;
    const breakEven  = parseFloat((shortStrike + credit).toFixed(2));
    const pop        = parseFloat(((1 - probITM(S, breakEven, T, RISK_FREE_RATE, shortIV, "call")) * 100).toFixed(1));

    return {
        strategy:    "Bear Call Spread",
        direction:   "BEAR",
        type:        "credit",
        trendLabel:  "▼ BEAR",
        legs: [
            { action: "SELL", type: "CALL", strike: shortStrike, iv: +((shortIV * 100).toFixed(1)), theorPrice: +(shortP.toFixed(2)), delta: +(bsDelta(S, shortStrike, T, RISK_FREE_RATE, shortIV, "call").toFixed(2)) },
            { action: "BUY",  type: "CALL", strike: longStrike,  iv: +((longIV  * 100).toFixed(1)), theorPrice: +(longP.toFixed(2)),  delta: +(bsDelta(S, longStrike,  T, RISK_FREE_RATE, longIV,  "call").toFixed(2)) },
        ],
        netCredit:    credit,
        spreadWidth:  width_,
        maxProfit,
        maxLoss,
        riskReward:   rr,
        breakEven,
        profitZone:   `Below $${breakEven}`,
        probOfProfit: pop,
        targetPrice:  shortStrike,
        targetNote:   `▼ Full credit kept if price stays below $${shortStrike} at expiry`,
    };
}

// ── LONG STRADDLE ─────────────────────────────────────────────────────────────

/**
 * Long Straddle — BUY ATM call + BUY ATM put.
 * Debit. Profits on large moves in either direction.
 * Used when negative GEX signals dealer-amplified trending moves.
 */
function buildLongStraddle(calls, puts, S, T) {
    const callStrike = findStrike(calls, S, "nearest");
    const putStrike  = findStrike(puts,  S, "nearest");

    const callIV = getIV(calls, callStrike, atmIV(calls, S));
    const putIV  = getIV(puts,  putStrike,  atmIV(puts,  S));

    const callP = bsPrice(S, callStrike, T, RISK_FREE_RATE, callIV, "call");
    const putP  = bsPrice(S, putStrike,  T, RISK_FREE_RATE, putIV,  "put");

    const totalDebit  = parseFloat((callP + putP).toFixed(2));
    const maxLoss     = Math.round(totalDebit * CONTRACT_SIZE);
    const upperBE     = parseFloat((callStrike + totalDebit).toFixed(2));
    const lowerBE     = parseFloat((putStrike  - totalDebit).toFixed(2));
    const impliedMove = parseFloat((totalDebit / S * 100).toFixed(2));

    return {
        strategy:       "Long Straddle",
        direction:      "VOLATILE",
        type:           "debit",
        trendLabel:     "⚡ VOLATILE",
        legs: [
            { action: "BUY", type: "CALL", strike: callStrike, iv: +((callIV * 100).toFixed(1)), theorPrice: +(callP.toFixed(2)), delta: +(bsDelta(S, callStrike, T, RISK_FREE_RATE, callIV, "call").toFixed(2)) },
            { action: "BUY", type: "PUT",  strike: putStrike,  iv: +((putIV  * 100).toFixed(1)), theorPrice: +(putP.toFixed(2)),  delta: +(bsDelta(S, putStrike,  T, RISK_FREE_RATE, putIV,  "put").toFixed(2))  },
        ],
        totalDebit,
        maxLoss,
        maxProfit:       "Unlimited",
        riskReward:      "Unlimited",
        upperBreakEven:  upperBE,
        lowerBreakEven:  lowerBE,
        impliedMovePct:  impliedMove,
        targetPrice:     upperBE,   // upside target (call side)
        lowerTarget:     lowerBE,   // downside target (put side)
        targetNote:      `⚡ Profit if price moves beyond $${lowerBE} ↓ or $${upperBE} ↑`,
    };
}

// ── STRATEGY SELECTOR ─────────────────────────────────────────────────────────

/**
 * Choose ONE spread — credit OR debit — based on IV level, DTE, and bias.
 * Iron Condor is never recommended.
 *
 * Selection rules:
 *   BULL + high IV (>30%) OR short DTE (≤3) → Bull Put Spread  (credit)
 *   BULL + normal IV and long DTE            → Bull Call Spread (debit)
 *   BEAR + high IV OR short DTE             → Bear Call Spread (credit)
 *   BEAR + normal IV and long DTE            → Bear Put Spread  (debit)
 *   Negative GEX (trending regime)           → adds Straddle as alternative
 *
 * @param {object} optionsData  from analyzeOptions() — must include rawChain
 * @param {object} prediction   { bias, confidence } from predictNextCandle()
 * @returns {{ recommended, alternative, rationale[], ivRegime, creditOrDebit, S, T, dte } | null}
 */
function recommendSpread(optionsData, prediction) {
    if (!optionsData?.rawChain) return null;

    const { rawChain, levels, dte, spotPrice: S, flow } = optionsData;
    const { calls, puts, expirationDate }               = rawChain;
    if (!calls?.length && !puts?.length) return null;

    const msLeft   = expirationDate * 1000 - Date.now();
    const T        = Math.max(msLeft / (365.25 * 24 * 3600 * 1000), 0.5 / 365);
    const { bias, confidence } = prediction;
    const posGEX   = levels.posGEX;
    const width    = autoWidth(S);

    // IV regime — determines credit vs debit preference
    const allChain = [...(calls || []), ...(puts || [])];
    const curATMiv = atmIV(allChain, S);
    const highIV   = curATMiv > HIGH_IV_THRESH;
    const shortDTE = dte <= SHORT_DTE_THRESH;
    const useCredit = highIV || shortDTE;
    const ivRegime  = highIV ? `HIGH (${(curATMiv * 100).toFixed(0)}% > ${HIGH_IV_THRESH * 100}% threshold)`
                             : `NORMAL (${(curATMiv * 100).toFixed(0)}%)`;

    // ── Build primary candidate based on bias ──────────────────────────────────
    let primary   = null;
    let secondary = null;   // the other credit/debit variant for same direction

    if (bias === "BULL" || (bias === "NEUTRAL" && posGEX)) {
        if (useCredit) {
            primary   = buildBullPutSpread(puts,  S, T, width);
            secondary = buildBullCallSpread(calls, S, T, width);
        } else {
            primary   = buildBullCallSpread(calls, S, T, width);
            secondary = buildBullPutSpread(puts,   S, T, width);
        }
    } else if (bias === "BEAR" || (bias === "NEUTRAL" && !posGEX)) {
        if (useCredit) {
            primary   = buildBearCallSpread(calls, S, T, width);
            secondary = buildBearPutSpread(puts,   S, T, width);
        } else {
            primary   = buildBearPutSpread(puts,  S, T, width);
            secondary = buildBearCallSpread(calls, S, T, width);
        }
    } else {
        // Neutral with no clear GEX signal — fall back to bias tiebreaker
        primary   = buildBullCallSpread(calls, S, T, width);
        secondary = buildBearPutSpread(puts,   S, T, width);
    }

    // Straddle as an alternative when negative GEX signals explosive moves
    const straddle = !posGEX ? buildLongStraddle(calls, puts, S, T) : null;

    if (!primary) primary = secondary;
    if (!primary) return null;

    // ── Build rationale ────────────────────────────────────────────────────────
    const rationale = [];
    const choiceType = useCredit ? "CREDIT" : "DEBIT";

    rationale.push(
        `${bias} bias at ${confidence}% confidence | IV ${ivRegime} | ${dte} DTE → ${choiceType} spread selected`
    );

    if (primary.type === "credit") {
        rationale.push(
            `${useCredit && highIV ? "High IV — sell the elevated premium" : "Short DTE — theta decays fast in your favour"}`
        );
        rationale.push(
            `Keep full credit of $${primary.netCredit}/share ($${primary.maxProfit}/contract) if price ${primary.direction === "BULL" ? "holds above" : "stays below"} $${primary.targetPrice}`
        );
    } else {
        rationale.push(
            `Normal IV — buy direction cheaply; debit capped at $${primary.maxLoss}/contract`
        );
        rationale.push(
            `Max profit of $${primary.maxProfit}/contract if price ${primary.direction === "BULL" ? "reaches" : "falls to"} $${primary.targetPrice}`
        );
    }

    if (!posGEX) rationale.push(`Negative GEX (${(levels.totalGEX / 1e6).toFixed(1)}M) — dealers amplify trends; directional play justified`);
    if (posGEX)  rationale.push(`Positive GEX (${(levels.totalGEX / 1e6).toFixed(1)}M) — pinning force near $${levels.gammaPin} supports credit spread`);
    if (dte <= 7) rationale.push(`${dte} DTE — rapid theta decay; manage position at 50% of max profit/loss`);

    // Build alternatives list
    const alternatives = [];
    if (secondary)  alternatives.push(secondary);
    if (straddle)   alternatives.push(straddle);

    return {
        recommended:   primary,
        alternative:   secondary  || null,   // single clear alternative
        straddle:      straddle   || null,   // only present when negGEX
        alternatives,
        rationale,
        ivRegime,
        creditOrDebit: choiceType,
        width,
        S,
        T,
        dte,
    };
}

module.exports = { recommendSpread, bsPrice, bsDelta };
