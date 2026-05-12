# AI Stocks Dashboard

A real-time NDX / SPX trading signal dashboard built with pure Node.js — no npm dependencies required. Polls Yahoo Finance every 5 minutes, analyses market data with classic indicators, Smart Money Concepts, Order Flow, options chain, and a local AI advisor, then writes a fully self-contained `dashboard.html` you can open in any browser.

---

## Features

| Module | What it does |
|--------|-------------|
| **Signal Engine** | EMA 9/21/200, RSI 14, MACD, volume filter → BUY / SELL / STRONG signals |
| **Smart Money Concepts** | Liquidity sweeps, Fair Value Gaps, volume climax & delta proxy |
| **Order Flow Analysis** | Market structure (HH/HL/LH/LL), CHoCH, BOS, Order Blocks, Displacement, Premium/Discount zones |
| **Options Flow** | GEX, gamma pin/flip, call/put walls, max pain, PCR via QQQ/SPY chain |
| **Spread Calculator** | Recommends the best debit/credit spread given current IV and bias |
| **AI Trade Advisor** | Local LM Studio (gemma-4-e2b-it) gives action, conviction, entry/stop/target |
| **AI ETF Monitor** | Live prices, RSI, trend and mini-sparkline for 7 AI/semiconductor ETFs |
| **Earnings Calendar** | Upcoming ± 45-day earnings for NVDA, MSFT, GOOGL, META, TSLA, AMD, AVGO, AMZN, INTC, SMCI |
| **AI News Feed** | Dedicated RSS from VentureBeat AI, TechCrunch AI, CNBC Tech, Reuters Tech |
| **Top Picks News** | Per-ticker Yahoo Finance RSS for the screener's top 5 picks |
| **Confirmed Flip Alerts** | Multi-factor confirmation guard filters noise before sending BUY ↔ SELL push |
| **AI Screener** | Screens 50+ stocks with risk guards, growth scoring, and optional LLM verdicts |
| **Dashboard** | Self-contained `dashboard.html` — open via `file://`, auto-reloads every 60 s |

---

## Architecture

```
signal_checker.js          ← main polling loop (NDX + SPX every 5 min)
  ├── news_aggregator.js   ← 25 stories from 5 RSS sources
  ├── options_checker.js   ← QQQ / SPY options chain (GEX, Greeks, PCR)
  ├── spread_calculator.js ← debit / credit spread recommendation
  ├── ollama_advisor.js    ← LM Studio inference (gemma-4-e2b-it)
  ├── ai_etf_monitor.js    ← AI ETF prices + earnings + AI news + top picks news
  └── dashboard_writer.js  ← writes dashboard.html + signals_history.json

webhook_monitor.js         ← HTTP server (port 3001) for TradingView alerts

enhanced_screener.js       ← AI stock screener with risk guards + LLM scoring
start_screener.js          ← scheduler wrapper for the screener (default: every 24h)

start.js                   ← launches webhook_monitor + signal_checker together
```

---

## Quick Start

### Prerequisites

- **Node.js 16+** — no `npm install` needed, zero external dependencies
- **LM Studio** running locally on port 1234 with `gemma-4-e2b-it` loaded
- **ntfy.sh** account (free) for push notifications

### 1. Clone

```bash
git clone https://github.com/kinsha-dev/ai-stocks-dashboard.git
cd ai-stocks-dashboard
```

### 2. Configure environment (optional — all have defaults)

```bash
export NTFY_TOPIC="your-ntfy-topic"          # default: ndx-signals-kinsha
export NTFY_SERVER="https://ntfy.sh"          # default: ntfy.sh
export NTFY_TOKEN=""                          # optional: ntfy.sh auth token
export POLL_INTERVAL=5                        # minutes between polls (default: 5)
export LMS_HOST="http://127.0.0.1:1234"       # LM Studio host (default: 127.0.0.1:1234)
export LMS_MODEL="gemma-4-e2b-it"             # LM Studio model (default: gemma-4-e2b-it)
```

### 3. Start the signal monitor

```bash
# Start both the webhook server and the signal checker together
node start.js

# Or run just the signal checker
node signal_checker.js
```

Open `dashboard.html` in your browser (double-click or `open dashboard.html`). It refreshes automatically every 60 seconds.

### 4. Run the AI screener (optional)

```bash
# Run once and exit
node start_screener.js --once

# Run now and repeat every 24 h (default)
node start_screener.js

# Skip LLM for a fast run
node start_screener.js --no-llm

# Show top 10 picks, repeat every 12 h
node start_screener.js --top 10 --interval 12

# Run as a background daemon (requires pm2)
pm2 start start_screener.js
```

---

## Dashboard Tabs

### 🤖 AI ETFs (default tab)

- **Sector sentiment bar** — overall AI sector trend (Strongly Bullish → Strongly Bearish)
- **7 ETF cards** — BOTZ · AIQ · SOXX · SMH · ARKQ · IRBO · QTUM with price, day/week change, RSI, volume ratio, EMA trend badge, and mini sparkline
- **Top Picks News** — latest headlines for each of the screener's top 5 picks (ticker badge + sentiment score per article)
- **Earnings Calendar** — AI leaders with EPS estimate range and days-to-report
- **AI & Tech News** — grouped by source with bullish/bearish sentiment scoring

### NDX / SPX tabs

- Live price header with trend badge and signal
- 5-card summary: Signal · Prediction confidence · AI Advisor · News sentiment · Spread
- Price history sparkline with BUY/SELL markers
- 5-day signal history table (100 rows)
- **Four** bottom panels: Order Flow · Options chain · Spread recommendation · AI Trade Advisor
- Full news feed with per-article sentiment scores

---

## Order Flow Analysis

Runs every poll cycle on recent 30-minute bars (last ~2 trading days):

| Concept | Description | Prediction weight |
|---------|-------------|------------------|
| **Market Structure** | BULLISH (HH+HL) / BEARISH (LH+LL) / RANGING | +1 pt |
| **CHoCH** | Change of Character — first close against prevailing structure, signals potential reversal | **+2 pts** |
| **BOS** | Break of Structure — close past last swing in trend direction, confirms continuation | +1 pt |
| **Displacement** | 3+ consecutive strong-body candles — institutional imbalance | +1 pt |
| **Order Block** | Last opposite-colour candle before a displacement — high-probability re-entry zone | displayed |
| **Premium / Discount** | Price position in the current swing range (above/below 50% equilibrium) | +1 pt |

The Order Flow panel on each symbol tab shows the active market structure badge, event rows (CHoCH/BOS/Displacement), Order Block zone, and a Premium/Discount progress bar.

---

## Push Notifications

Notifications are sent via **ntfy.sh** (no account needed for the default public topic).

| Event | Priority | Notes |
|-------|----------|-------|
| STRONG BUY / STRONG SELL | 5 (urgent) | Classic signal, all conditions met |
| BUY / SELL | 4 (high) | Classic signal |
| **Confirmed flip** — Classic / SMC triggered | 5 (urgent) | Score ≥ 3, 30-min cooldown |
| **Confirmed flip** — AI triggered | 4 (high) | Score ≥ 4, 30-min cooldown |

### Flip Confirmation Guard

Every BUY ↔ SELL direction change is scored against 9 independent factors before a notification fires. This filters AI oscillation noise while still catching real reversals.

| Factor | Points |
|--------|--------|
| AI advisor agrees with new direction | +1 |
| Prediction bias matches | +1 |
| EMA 200 macro trend aligned | +1 |
| EMA 9/21 alignment (EMA9 above/below EMA21) | +1 |
| EMA 9/21 fresh cross within last 3 bars | +1 |
| Classic bull/bear score ≥ 2/3 | +1 |
| CHoCH in flip direction | **+2** |
| BOS in flip direction | +1 |
| Market structure aligned | +1 |
| Institutional displacement | +1 |

**Thresholds:** Classic/SMC-triggered flip requires score ≥ 3. AI-only triggered flip requires score ≥ 4.  
**Cooldown:** 30 minutes between flip notifications per symbol — prevents rapid oscillation alerts.  
**Suppressed flips** are logged to console with the exact reason (score short / cooldown active).

Subscribe on your phone: install the [ntfy app](https://ntfy.sh) and subscribe to your topic.

### TradingView webhook (optional)

Point a TradingView alert to:
```
http://<your-machine>:3001/webhook
```
Body format: `{"symbol":"SPX","signal":"STRONG_BUY","price":5300}`

---

## AI ETFs Tracked

| Ticker | Name | Theme |
|--------|------|-------|
| BOTZ | Global X Robotics & AI | AI / Robotics |
| AIQ | Global X AI & Technology | AI / Tech |
| SOXX | iShares Semiconductor | Semiconductors |
| SMH | VanEck Semiconductor | Semiconductors |
| ARKQ | ARK Autonomous Technology | Autonomous / AI |
| IRBO | iShares Robotics & AI | Robotics / AI |
| QTUM | Defiance Quantum ETF | Quantum / AI |

---

## Earnings Watch List

NVDA · MSFT · GOOGL · META · TSLA · AMD · AVGO · AMZN · INTC · SMCI

---

## AI News Sources

| Source | Feed |
|--------|------|
| VentureBeat AI | `/category/ai/feed/` |
| TechCrunch AI | `/tag/artificial-intelligence/feed/` |
| CNBC Tech | CNBC technology RSS |
| Reuters Tech | Reuters technology news |

---

## File Reference

| File | Purpose |
|------|---------|
| `signal_checker.js` | Main polling loop — NDX + SPX signals every 5 min |
| `webhook_monitor.js` | HTTP server for TradingView webhook alerts |
| `dashboard_writer.js` | Generates `dashboard.html` from signal history + ETF data |
| `ai_etf_monitor.js` | Fetches AI ETF prices, earnings, AI news, top picks news |
| `news_aggregator.js` | Fetches and scores news from 5 RSS sources |
| `options_checker.js` | QQQ / SPY options chain analysis |
| `spread_calculator.js` | Recommends debit/credit spread strategy |
| `ollama_advisor.js` | LM Studio API client (OpenAI-compatible) |
| `enhanced_screener.js` | AI stock screener with risk guards + growth scoring |
| `ai_screener.js` | Original screener (superseded by enhanced_screener) |
| `start.js` | Launches webhook monitor + signal checker together |
| `start_screener.js` | Scheduled runner for the AI screener |
| `dashboard.html` | Generated output — open in any browser |
| `signals_history.json` | Rolling 5-day signal history (auto-managed) |
| `screener_results.json` | Latest screener top 5 picks |
| `ai_etf_data.json` | Latest AI ETF fetch output |

---

## Changelog

### v3.0 — 2026-05-12
- **EMA 9/21 fine-tuned** — split into two independent confirmation factors:
  alignment (EMA9 position vs EMA21, persistent) + fresh cross (within last 3 bars, bonus)
- **Flip cooldown extended** to 30 minutes per symbol (was 15 min)

### v2.9 — 2026-05-12
- **Multi-factor flip confirmation guard** — scores 9 independent factors before sending
  a BUY ↔ SELL notification; thresholds differ by source (Classic ≥ 3, AI ≥ 4)
- **AI advisor included in flip detection** — AI BUY/SELL changes now trigger the flip
  pipeline as a third-priority fallback (after classic signal and SMC ≥70% confidence)
- Suppressed flips logged to console with score and reason

### v2.8 — 2026-05-11
- **Order Flow Analysis** — new `detectMarketStructure()` in `signal_checker.js`:
  market structure (HH/HL/LH/LL), CHoCH (+2 pts), BOS (+1 pt), Displacement (+1 pt),
  Order Blocks, Premium/Discount zones (+1 pt)
- Prediction engine max score raised to 16 (no options) / 20 (with options)
- **Order Flow panel** added to NDX/SPX dashboard tabs (4th lower panel)
- `smcBadge()` extended with CHoCH↑/↓, BOS↑/↓, Disp↑/↓ badges
- Console logs STRUCT / CHoCH / BOS / DISP lines each poll cycle

### v2.7 — 2026-05-11
- **AI advisor included in flip detection** (initial implementation — superseded by v2.9 guard)
- Flip notification title shows source tag `[AI]` / `[SMC]`

### v2.6 — 2026-05-11
- **Dedicated AI news sources** — VentureBeat AI, TechCrunch AI, CNBC Tech, Reuters Tech
  (replaces keyword-filtered general news feed)
- **Top Picks News** — per-ticker Yahoo Finance RSS for screener top 5, shown in AI ETFs tab
- AI ETFs tab layout: Top Picks News + Earnings left, AI Theme News right

### v2.5 — 2026-05-10
- **AI ETFs tab** added as default first tab — 7 ETF cards with RSI, volume ratio, sparkline
- Earnings calendar with ±45-day window (shows recently-reported earnings during gap periods)
- Sector sentiment bar (Strongly Bullish → Strongly Bearish)
- Fixed JS syntax error in `render()` that caused blank tabs (template literal quote escaping)

### v2.4 — 2026-05-10
- **Signal flip push notifications** — BUY → SELL or SELL → BUY sends priority-5 alert
- LLM backend switched from Ollama to **LM Studio** (gemma-4-e2b-it, OpenAI-compatible API)
- Removed `response_format: json_object` (not supported by LM Studio)

---

## License

MIT
