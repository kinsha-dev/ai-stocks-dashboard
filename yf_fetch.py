#!/usr/bin/env python3
"""
yf_fetch.py — Yahoo Finance data fetcher for ai_screener.js

Fetches OHLCV, analyst data, and news for a list of tickers using yfinance.
Outputs a single JSON object to stdout.

Usage:
    python3 yf_fetch.py NVDA AMD AAPL ...
    python3 yf_fetch.py --file tickers.txt
"""

import sys
import json
import time
import datetime
import traceback

try:
    import yfinance as yf
except ImportError:
    print(json.dumps({"error": "yfinance not installed — run: pip install yfinance"}))
    sys.exit(1)


def fetch_ticker(ticker):
    try:
        t = yf.Ticker(ticker)

        # ── OHLCV (2 years daily) ──────────────────────────────────────────────
        hist = t.history(period="2y", auto_adjust=True)
        if hist.empty:
            return {"error": "no price data"}

        dates   = [str(d.date()) for d in hist.index]
        opens   = [round(float(v), 4) if v == v else None for v in hist["Open"]]
        highs   = [round(float(v), 4) if v == v else None for v in hist["High"]]
        lows    = [round(float(v), 4) if v == v else None for v in hist["Low"]]
        closes  = [round(float(v), 4) if v == v else None for v in hist["Close"]]
        volumes = [int(v)             if v == v else None for v in hist["Volume"]]

        # ── Analyst / fundamental data ─────────────────────────────────────────
        info = {}
        try:
            info = t.info or {}
        except Exception:
            pass

        current_price   = info.get("currentPrice") or info.get("regularMarketPrice") or (closes[-1] if closes else 0)
        target_mean     = info.get("targetMeanPrice") or 0
        target_high     = info.get("targetHighPrice") or 0
        rec_mean        = info.get("recommendationMean") or 3
        rec_key         = info.get("recommendationKey") or "hold"
        num_analysts    = info.get("numberOfAnalystOpinions") or 0
        rev_growth      = info.get("revenueGrowth") or 0
        earn_growth     = info.get("earningsGrowth") or 0
        gross_margins   = info.get("grossMargins") or 0
        beta            = info.get("beta") or 1
        market_cap      = info.get("marketCap") or 0
        # regularMarketChangePercent is already in percent units (e.g. 4.32 = 4.32%), NOT decimal
        day_chg_pct     = float(info.get("regularMarketChangePercent") or 0)

        upside_pct = (target_mean - current_price) / current_price * 100 if current_price > 0 and target_mean > 0 else 0

        # ── Upgrade/Downgrade history (last 30 days) ──────────────────────────
        upgrades_count   = 0
        downgrades_count = 0
        recent_history   = []
        try:
            udh = t.upgrades_downgrades
            if udh is not None and not udh.empty:
                cutoff = datetime.datetime.now(tz=datetime.timezone.utc) - datetime.timedelta(days=30)
                # index is GradeDate
                udh_recent = udh[udh.index >= cutoff] if hasattr(udh.index, 'tz') else udh
                BULL_GRADES = {"buy","strongbuy","overweight","outperform","accumulate","positive"}
                for idx, row in udh_recent.head(20).iterrows():
                    action  = str(row.get("Action","")).lower()
                    to_grade = str(row.get("ToGrade","")).lower()
                    if action in ("up","init","reit") and any(g in to_grade for g in BULL_GRADES):
                        upgrades_count += 1
                    elif action == "down":
                        downgrades_count += 1
                    recent_history.append({
                        "firm":   str(row.get("Firm","")),
                        "action": action,
                        "from":   str(row.get("FromGrade","")),
                        "to":     str(row.get("ToGrade","")),
                        "date":   str(idx.date()) if hasattr(idx, "date") else str(idx)[:10],
                    })
                recent_history = recent_history[:5]
        except Exception:
            pass

        # ── News ──────────────────────────────────────────────────────────────
        news_items = []
        try:
            raw_news = t.news or []
            for n in raw_news[:8]:
                title = ""
                url   = ""
                pub   = ""
                # Handle both old and new yfinance news formats
                if isinstance(n, dict):
                    content = n.get("content", {})
                    if isinstance(content, dict):
                        title = content.get("title", "")
                        pub   = str(content.get("pubDate", ""))
                        # URL from clickThroughUrl or canonicalUrl
                        ctu = content.get("clickThroughUrl", {}) or {}
                        can = content.get("canonicalUrl", {}) or {}
                        url = ctu.get("url", "") or can.get("url", "") or ""
                    else:
                        title = n.get("title", "")
                        pub   = str(n.get("providerPublishTime", ""))
                        url   = n.get("link", "") or n.get("url", "")
                if title and len(title) > 10:
                    news_items.append({"title": title, "url": url, "pubDate": pub})
        except Exception:
            pass

        return {
            "ohlcv": {
                "dates":   dates,
                "opens":   opens,
                "highs":   highs,
                "lows":    lows,
                "closes":  closes,
                "volumes": volumes,
                "meta": {
                    "symbol":              ticker,
                    "regularMarketPrice":  current_price,
                    "previousClose":       info.get("previousClose") or (closes[-2] if len(closes) >= 2 else 0),
                },
            },
            "analyst": {
                "currentPrice":       current_price,
                "targetMean":         target_mean,
                "targetHigh":         target_high,
                "upsidePct":          round(upside_pct, 2),
                "recommendationMean": rec_mean,
                "recommendationKey":  rec_key,
                "numberOfAnalysts":   num_analysts,
                "revenueGrowth":      rev_growth,
                "earningsGrowth":     earn_growth,
                "grossMargins":       gross_margins,
                "beta":               beta,
                "marketCap":          market_cap,
                "dayChangePct":       round(day_chg_pct, 2),
                "upgrades":           upgrades_count,
                "downgrades":         downgrades_count,
                "recentHistory":      recent_history,
            },
            "news": news_items,
        }

    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()[-500:]}


def main():
    tickers = []

    args = sys.argv[1:]
    if "--file" in args:
        idx = args.index("--file")
        with open(args[idx + 1]) as f:
            tickers = [line.strip() for line in f if line.strip()]
    else:
        tickers = [a for a in args if not a.startswith("--")]

    if not tickers:
        print(json.dumps({"error": "no tickers provided"}))
        sys.exit(1)

    results = {}
    for i, ticker in enumerate(tickers):
        if i > 0 and i % 10 == 0:
            time.sleep(1)   # gentle rate limiting
        results[ticker] = fetch_ticker(ticker)
        sys.stderr.write(f"  [{i+1}/{len(tickers)}] {ticker} — {'OK' if 'error' not in results[ticker] else results[ticker]['error']}\n")
        sys.stderr.flush()

    print(json.dumps(results))


if __name__ == "__main__":
    main()
