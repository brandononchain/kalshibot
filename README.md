# KALSHIBOT

**Autonomous multi-strategy trading system for Bitcoin binary prediction markets.**

Kalshibot exploits structural pricing inefficiencies between Binance spot BTC, Polymarket prediction contracts, and Kalshi's 15-minute rolling Bitcoin markets. It combines a Geometric Brownian Motion probability model, cross-exchange arbitrage detection, and Kelly Criterion position sizing to execute high-frequency, edge-positive trades with full real-time observability.

---

## Table of Contents

- [Abstract](#abstract)
- [System Architecture](#system-architecture)
- [Market Microstructure](#market-microstructure)
- [Trading Strategies](#trading-strategies)
- [Probability Model](#probability-model)
- [Position Sizing](#position-sizing)
- [Risk Management](#risk-management)
- [Execution Engine](#execution-engine)
- [Data Infrastructure](#data-infrastructure)
- [Real-Time Dashboard](#real-time-dashboard)
- [Performance Metrics](#performance-metrics)
- [Technical Stack](#technical-stack)
- [Getting Started](#getting-started)
- [Configuration Reference](#configuration-reference)
- [Disclaimer](#disclaimer)

---

## Abstract

Kalshibot is an automated trading agent that targets Kalshi's `KXBTC15M` series -- 15-minute binary contracts on whether Bitcoin's price will be higher or lower at settlement. The system ingests real-time price data from Binance (via WebSocket), fair-value signals from Polymarket (via REST polling), and on-chain oracle prices from RedStone, then generates trading signals through three independent strategy modules: (1) directional trading based on a GBM-derived implied probability model, (2) cross-exchange arbitrage when Polymarket fair value diverges from Kalshi contract pricing, and (3) dual-side guaranteed-profit trades when the combined cost of YES + NO contracts falls below $1.00. All positions are sized using fractional Kelly Criterion and managed through adaptive scan-rate execution, automated take-profit triggers, and real-time portfolio monitoring via a web-based Mission Control dashboard.

---

## System Architecture

```
                          KALSHIBOT SYSTEM ARCHITECTURE
 ============================================================================

  DATA LAYER                    ENGINE                      INTERFACE
 ──────────────────────────────────────────────────────────────────────────────

  ┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
  │ Binance WebSocket│     │                      │     │  Mission Control │
  │ btcusdt@bookTick │────>│   Strategy Engine     │     │   (Dashboard)    │
  │ ~200ms latency   │     │                      │     │                  │
  │ + REST fallback  │     │  ┌────────────────┐  │     │  P&L Chart       │
  └─────────────────┘     │  │ Normal CDF      │  │     │  Bot Intent      │
                           │  │ Implied Prob    │  │     │  Active Markets  │
  ┌─────────────────┐     │  │ Kelly Sizing    │  │     │  Open Positions  │
  │ Polymarket CLOB  │     │  └────────────────┘  │     │  Trade Log       │
  │ Gamma + Price API│────>│                      │     │  14 Statistics   │
  │ 4s poll cycle    │     │  3 Signal Generators  │     │  4 Connection    │
  │ Slug-based disc. │     │  ┌────┐ ┌────┐ ┌───┐ │     │    Status Dots   │
  └─────────────────┘     │  │DIR │ │ARB │ │DUL│ │     └────────┬─────────┘
                           │  └────┘ └────┘ └───┘ │              │
  ┌─────────────────┐     │                      │     Socket.io (real-time)
  │ Kalshi REST API  │     │  Adaptive Scan Rate  │              │
  │ RSA-PSS Auth     │<───>│  1s-3s based on vol  │──────────────┘
  │ Order Execution  │     │                      │
  └─────────────────┘     │  Take-Profit Monitor  │
                           │  Settlement Handler   │
  ┌─────────────────┐     │                      │
  │ RedStone Oracle  │     │  State Persistence   │
  │ Multi-gateway    │────>│  (JSON, atomic write) │
  │ 3s poll cycle    │     └──────────────────────┘
  └─────────────────┘
```

---

## Market Microstructure

### The Instrument

Kalshi's `KXBTC15M` series consists of rolling 15-minute binary contracts on Bitcoin price direction. Each contract settles to $1.00 if BTC's price is higher at the end of the 15-minute window than at the start, and $0.00 otherwise. New contracts are continuously created, providing a steady stream of tradable instruments.

### The Opportunity

Binary prediction markets exhibit a structural latency asymmetry:

1. **Binance spot BTC** updates via WebSocket approximately every 200ms
2. **Kalshi contract prices** reprice with a 3-7 second lag relative to spot movements
3. **Polymarket equivalent contracts** serve as an independent fair-value benchmark

This latency window creates a systematic edge: when BTC moves on Binance, the probability of the contract's outcome changes immediately, but Kalshi's order book takes several seconds to reflect the new equilibrium. During this window, contracts are mispriced relative to their true implied probability.

### Why the Edge Persists

- Kalshi's order book is thinner than centralized spot exchanges, resulting in slower price discovery
- Market makers on Kalshi do not have the same low-latency infrastructure as spot exchanges
- The 15-minute contract duration creates continuous new opportunities across overlapping windows
- Polymarket operates as a fully independent venue with its own price formation dynamics

---

## Trading Strategies

Kalshibot employs three independent signal generators, each targeting a different market inefficiency. Signals are generated in parallel, sorted by edge magnitude, and executed sequentially.

### Strategy 1: Directional Trading (Spot Divergence)

Exploits the latency between Binance spot price movements and Kalshi contract repricing.

**Signal Logic:**

```
modelEdge_YES = (P(UP) - Kalshi_YES_ask) * 100
modelEdge_NO  = (P(DOWN) - Kalshi_NO_ask) * 100

IF modelEdge > MIN_DIVERGENCE (default 8%):
    Generate BUY signal on the mispriced side
```

Where `P(UP)` is the model-implied probability derived from the GBM framework (see [Probability Model](#probability-model)).

**Entry Conditions:**
- Binance BTC price is live (updated within 5 seconds)
- Model-implied probability diverges from Kalshi contract price by >= `MIN_DIVERGENCE`
- Time since market open < `TRADING_WINDOW` (default 10 minutes)
- Time until settlement > 30 seconds
- Sufficient available balance

### Strategy 2: Cross-Exchange Arbitrage (Polymarket Signal)

Exploits pricing divergence between Polymarket fair value and Kalshi ask prices.

**Signal Logic:**

```
polyFair_UP   = (Polymarket_UP_bid + Polymarket_UP_ask) / 2
polyFair_DOWN = (Polymarket_DOWN_bid + Polymarket_DOWN_ask) / 2

polyEdge_YES = (polyFair_UP - Kalshi_YES_ask) * 100
polyEdge_NO  = (polyFair_DOWN - Kalshi_NO_ask) * 100

IF polyEdge > MIN_EDGE (default 5%):
    BUY the underpriced side on Kalshi
```

**Rationale:** Polymarket's higher liquidity and broader participant base provide a more efficient price discovery mechanism. When Polymarket's mid-price for a direction exceeds Kalshi's ask, the Kalshi contract is undervalued relative to cross-market consensus.

### Strategy 3: Dual-Side Arbitrage (Risk-Free)

Captures guaranteed profit when Kalshi's order book misprices the combined cost of YES + NO contracts below $1.00.

**Signal Logic:**

```
combined = Kalshi_YES_ask + Kalshi_NO_ask

IF combined < $0.98:
    BUY both YES and NO simultaneously
    Guaranteed profit = ($1.00 - combined) per contract pair
```

**Mechanics:**
- One side always settles at $1.00, the other at $0.00
- Combined cost < $1.00 guarantees net positive return regardless of outcome
- Position is split equally: half YES, half NO
- Threshold set at $0.98 to ensure minimum 2% guaranteed return after fees

---

## Probability Model

### Geometric Brownian Motion Framework

The directional strategy derives implied probabilities from a Geometric Brownian Motion (GBM) model for BTC price evolution over the remaining contract duration.

**Core Formula:**

```
P(UP) = Phi(Z)

where:
    Z = move / (sigma * sqrt(T_remaining))
    move = (S_current - S_open) / S_open
    sigma = realized_volatility(window = contract_duration)
    T_remaining = time_remaining / total_duration
    Phi(x) = standard normal cumulative distribution function
```

- `S_current`: Current BTC spot price from Binance
- `S_open`: BTC price recorded at market open (captured on first discovery)
- `sigma`: Annualized realized volatility scaled to the contract's time horizon
- `T_remaining`: Fraction of total contract duration remaining (0 to 1)

### Normal CDF Approximation

The cumulative normal distribution is computed using the Abramowitz & Stegun (1964) rational approximation:

```
Phi(x) = 0.5 * (1 + sign(x) * Y)

where:
    Y = 1 - P(t) * exp(-x^2 / 2) / sqrt(2 * pi)
    P(t) = ((((a5*t + a4)*t + a3)*t + a2)*t + a1) * t
    t = 1 / (1 + p * |x|)

Constants:
    p  = 0.3275911
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
```

Bounded at `[-8, 8]` standard deviations to prevent numerical instability. Probabilities are clamped to `[0.01, 0.99]` to avoid extreme Kelly sizing.

### Realized Volatility Estimation

Volatility is estimated from the trailing window of 1-second Binance price samples using the standard log-return method. The window length matches the contract's total duration (900 seconds for 15-minute contracts), ensuring the volatility estimate reflects the relevant time horizon:

```
r_i = ln(P_i / P_{i-1})        for each consecutive price sample

mean = (1/N) * sum(r_i)
variance = (1/N) * sum((r_i - mean)^2)
std_per_sample = sqrt(variance)

avg_interval = (t_last - t_first) / (N - 1)
samples_in_window = window_seconds * 1000 / avg_interval

volatility = std_per_sample * sqrt(samples_in_window)
```

Default fallback: `0.15%` per 15-minute period when fewer than 10 samples are available. The price history buffer maintains 600 samples (~10 minutes at 1 sample/second).

### Edge Cases

| Condition | Behavior |
|-----------|----------|
| No Binance price data | Return neutral probability (50/50) |
| Near-zero remaining sigma (< 0.00001) | Price momentum determines outcome (99/1) |
| Fewer than 10 price samples | Use default volatility (0.15%) |

---

## Position Sizing

### Kelly Criterion

Position sizes are determined using the Kelly Criterion, which maximizes the long-term geometric growth rate of capital:

```
b = (1 / (1 - p)) - 1          Odds ratio (binary payout)
q = 1 - p                       Loss probability
f* = (b * p - q) / b            Full Kelly fraction

position_fraction = f* * KELLY_FRACTION    Fractional Kelly (default 25%)
position_fraction = min(position_fraction, 0.25)    Absolute cap

position_dollars = position_fraction * available_balance
position_dollars = min(position_dollars, MAX_POSITION_SIZE)
contracts = floor(position_dollars / contract_ask_price)
```

### Why Fractional Kelly

Full Kelly sizing is theoretically optimal but assumes perfect probability estimates. In practice:

- **Model uncertainty**: The GBM model is an approximation; true probabilities are unknown
- **Variance reduction**: Quarter-Kelly reduces variance by 75% while retaining 50% of the growth rate
- **Drawdown protection**: Maximum single-trade risk is capped at 25% of available balance
- **Ruin prevention**: Returns 0 if probability is extreme (< 1% or > 99%)

---

## Risk Management

### Per-Trade Controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_POSITION_SIZE` | $25 | Maximum dollar amount per individual trade |
| `MAX_POSITIONS_PER_CONTRACT` | 2 | Maximum concurrent positions on the same contract |
| Kelly fraction cap | 25% | Never risk more than 25% of available balance per trade |
| Balance validation | Every trade | Order rejected if cost exceeds available balance |

### Portfolio Controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_TOTAL_OPEN_POSITIONS` | 10 | Maximum concurrent open positions across all contracts |
| Exposure limit | 50% | Total position costs must not exceed 50% of total balance |
| Drawdown circuit breaker | 10% | Reduce position sizes by 50% if session loss exceeds 10% |
| Trading pause | 20% | Pause all trading for 15 minutes if session loss exceeds 20% |

### Operational Risk

| Scenario | Response |
|----------|----------|
| Binance WebSocket disconnects | Pause directional trading; continue arbitrage strategies |
| Binance + RedStone both fail | Full trading halt |
| Kalshi API returns errors | Stop new trades; manage existing positions to settlement |
| 5 consecutive execution failures | Emergency stop |
| Balance drops below $5 | Emergency stop |
| API authentication failure (401) | Immediate shutdown |

### Time-Based Restrictions

- **Trading window**: Only enter new positions within the first 10 minutes of each 15-minute contract
- **Close-proximity guard**: No new entries within 30 seconds of settlement
- **Take-profit minimum**: Sell orders require >= 30 seconds remaining to ensure fill execution

---

## Execution Engine

### Adaptive Scan Rate

The scan interval dynamically adjusts based on realized market volatility, measured every 15 seconds:

```
vol = getRecentVolatility(300s window)

if vol < 0.1%:   scanInterval = 3000ms    (calm market)
if 0.1% <= vol <= 0.3%:  scanInterval = 2000ms    (normal)
if vol > 0.3%:   scanInterval = 1000ms    (volatile - max speed)
```

This reduces unnecessary API calls during quiet periods while maximizing signal capture during high-volatility windows when edges appear and decay rapidly.

### Scan Cycle

Each scan cycle executes the following pipeline:

1. **Parallel market refresh**: Fetch all active Kalshi market prices simultaneously via `Promise.allSettled()`
2. **Cache update**: Write refreshed data to shared market cache (3-second TTL) for take-profit monitor
3. **Unrealized P&L**: Calculate mark-to-market value of all open positions (no additional API calls)
4. **Signal generation**: Run all three strategy modules against refreshed market data
5. **Signal ranking**: Sort signals by edge magnitude (highest first)
6. **Execution**: Execute signals sequentially with 100ms delay between same-contract trades

### Take-Profit Monitor

Runs independently every 3 seconds, reading from the shared market cache to avoid redundant API calls:

```
For each open position:
    currentBid = market bid for position's side (YES or NO)
    profitPct = (currentBid - entryPrice) / entryPrice * 100
    maxGain = 1.00 - entryPrice
    gainFraction = (currentBid - entryPrice) / maxGain

    IF profitPct > 15% OR gainFraction > 50%:
        SELL at current bid
```

### Settlement Flow

Positions that are not exited via take-profit are held to contract settlement:

1. Schedule settlement check at `closeTime + 60 seconds` (buffer for Kalshi processing)
2. Poll order fill status -- unfilled orders are removed from tracking
3. Poll market result (`yes` or `no`)
4. If not yet settled, retry every 30 seconds
5. Calculate P&L: `payout - (taker_fill_cost + taker_fees) / 100`
6. Update statistics, persist state, refresh balance

---

## Data Infrastructure

### Binance WebSocket Feed

| Property | Value |
|----------|-------|
| Protocol | WebSocket (`wss://`) |
| Stream | `btcusdt@bookTicker` |
| Update frequency | ~200ms (tick-level) |
| Data | Best bid/ask prices |
| Failover | Binance.US -> Binance Global -> REST polling (1s) |
| Reconnection | Exponential backoff (1s initial, 30s max) |
| Price history | 600 samples (~10 min), used for volatility calculation |

### Polymarket Feed

| Property | Value |
|----------|-------|
| Protocol | HTTP REST |
| APIs | Gamma API (event discovery) + CLOB API (pricing) |
| Poll interval | 4 seconds |
| Slug pattern | `btc-updown-15m-{slot_start_unix}` |
| Concurrency | 3 parallel fetches per cycle |
| Cache TTL | 4 seconds |
| Deduplication | Multiple Kalshi markets mapping to same Polymarket slug are fetched once |

### Kalshi REST API

| Property | Value |
|----------|-------|
| Authentication | RSA-PSS SHA-256 signature (`timestamp_ms + METHOD + path`) |
| Market discovery | `GET /trade-api/v2/markets?series_ticker=KXBTC15M&status=open` |
| Market pricing | `GET /trade-api/v2/markets/{ticker}` |
| Order placement | `POST /trade-api/v2/portfolio/orders` (limit orders only) |
| Balance | `GET /trade-api/v2/portfolio/balance` |
| Price format | Cents (0-100), converted to decimals internally |

### RedStone Oracle

| Property | Value |
|----------|-------|
| Protocol | HTTP REST |
| Poll interval | 3 seconds |
| Endpoints | 2 gateway endpoints + 1 fallback API |
| Aggregation | Median of all available signer packages |
| Role | Price validation and fallback source |

---

## Real-Time Dashboard

The Mission Control dashboard is served via Express and communicates with the engine through Socket.io event forwarding. All state changes emit named events that are broadcast to connected clients in real time.

### Dashboard Panels

| Panel | Content |
|-------|---------|
| **Connection Status** | 4 indicator dots: BIN (Binance), POLY (Polymarket), KAL (Kalshi), RED (RedStone) |
| **Key Metrics** | BTC/USD price, Total P&L, ROI, Account Balance |
| **Bot Intent** | Current status, pending action, model probability, edge, spot move, volatility, time remaining |
| **P&L Chart** | Cumulative profit/loss over time (Chart.js, persisted to localStorage) |
| **Open Positions** | Ticker, side, contracts, entry price, cost, edge, strategy type |
| **Active Markets** | All tracked contracts with bid/ask, combined spread, countdown |
| **Trade Log** | Chronological trade and settlement history (last 30 entries) |
| **Statistics** | 14 tracked metrics (see [Performance Metrics](#performance-metrics)) |

### Event Architecture

```
BotState (EventEmitter)
    │
    ├── price:binance        → BTC price updates
    ├── price:redstone       → Oracle price updates
    ├── balance              → Account balance changes
    ├── markets              → Active market list refresh
    ├── intent               → Bot status and reasoning
    ├── model                → Probability model outputs
    ├── trade                → Trade execution events
    ├── position:open        → New position added
    ├── position:close       → Position settled/exited
    ├── stats                → Statistics updates
    ├── connection:kalshi    → Connection status change
    ├── connection:polymarket → Connection status change
    └── connection:binance   → Connection status change
          │
          └──→ Socket.io broadcast to all connected dashboard clients
```

---

## Performance Metrics

The system tracks 14 statistics in real time, updated on every trade execution and scan cycle:

| Metric | Description |
|--------|-------------|
| Total Trades | Cumulative settled trades |
| Win Rate | Wins / (Wins + Losses) as percentage |
| Avg Edge | Mean edge at entry across all trades |
| Best Trade | Largest single-trade P&L |
| Worst Trade | Largest single-trade loss |
| Volume Traded | Cumulative dollar volume |
| Trades/Hour | Trade frequency |
| Open Positions | Current concurrent position count |
| Profit Factor | Gross Wins / Gross Losses |
| Avg Win | Mean P&L of winning trades |
| Avg Loss | Mean P&L of losing trades |
| Streak | Current consecutive win (+) or loss (-) streak |
| Unrealized P&L | Mark-to-market value of open positions (updated every scan cycle) |
| Strategy Breakdown | Per-strategy win/loss record (DIR, POLY, DUAL) |

### State Persistence

- **Format**: JSON file (`data/state.json`)
- **Write strategy**: Atomic (write to `.tmp`, then rename)
- **Debounce**: 5-second buffer to prevent write thrashing
- **Contents**: Stats, closed positions (last 100), trade log (last 500), P&L history (last 500)
- **Recovery**: On startup, loads persisted state and resumes accumulation
- **Client-side**: P&L chart data persisted to `localStorage` for dashboard refresh survival

---

## Technical Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| HTTP Client | Axios |
| WebSocket | ws |
| Web Server | Express |
| Real-Time Communication | Socket.io |
| Charting | Chart.js 4.4.7 |
| Configuration | dotenv |
| Authentication | RSA-PSS (Node.js crypto) |
| Persistence | JSON file (atomic writes) |
| Database | None (stateless between restarts except persisted JSON) |

**Dependencies** (5 total, zero native modules):
```
axios ^1.6.0
dotenv ^16.3.1
express ^4.21.0
socket.io ^4.7.5
ws ^8.18.0
```

---

## Getting Started

### Prerequisites

- Node.js 16+
- Kalshi API credentials with trading permissions ([Kalshi API Settings](https://kalshi.com/settings/api))
- RSA private key (PEM format) for Kalshi API authentication

### Installation

```bash
git clone https://github.com/your-repo/kalshibot.git
cd kalshibot
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials and desired parameters (see [Configuration Reference](#configuration-reference)).

### Launch

```bash
npm start
```

The Mission Control dashboard will be available at `http://localhost:3333`.

### Monitoring

- **Dashboard**: Open `http://localhost:3333` in any browser
- **Console**: All trade executions, settlements, and engine events are logged with timestamps
- **State**: Persisted automatically to `data/state.json`

---

## Configuration Reference

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `KALSHI_API_KEY` | string | *required* | Kalshi API public key |
| `KALSHI_PRIVATE_KEY_PATH` | path | `./kalshi_private_key.pem` | Path to RSA private key for API signing |
| `SERIES_TICKER` | string | `KXBTC15M` | Kalshi market series to trade |
| `SLOT_DURATION` | number | `900` | Contract duration in seconds (15 min) |
| `MIN_EDGE` | number | `5.0` | Minimum edge (%) for Polymarket arbitrage signals |
| `MIN_DIVERGENCE` | number | `8.0` | Minimum divergence (%) for directional signals |
| `MAX_POSITION_SIZE` | number | `25` | Maximum dollars per individual trade |
| `MAX_TOTAL_OPEN_POSITIONS` | number | `10` | Maximum concurrent open positions |
| `MAX_POSITIONS_PER_CONTRACT` | number | `2` | Maximum positions per contract ticker |
| `TRADING_WINDOW` | number | `10` | Only trade within first N minutes of contract |
| `USE_KELLY_SIZING` | boolean | `true` | Enable Kelly Criterion position sizing |
| `KELLY_FRACTION` | number | `0.25` | Fraction of full Kelly to use (0.25 = quarter-Kelly) |
| `PORT` | number | `3333` | Dashboard server port |

---

## Disclaimer

This software is provided for educational and research purposes only. Trading binary contracts involves substantial risk of loss and is not suitable for all investors. Past performance does not guarantee future results.

- This system trades with real capital on regulated exchanges
- No guarantee of profitability is expressed or implied
- Users are solely responsible for their own trading decisions and capital allocation
- Always start with small position sizes and monitor system behavior closely
- Ensure compliance with all applicable regulations in your jurisdiction

---

*Built with Node.js. No external databases. Five dependencies. One objective.*

