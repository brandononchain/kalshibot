> **Validity notice (2026-09):** These results are from the prior synthetic GBM simulator and are not a valid chronological replay of Kalshi order books or fills. The simulator uses future within-slot price data for indicators and applies settlement P&L before the simulated settlement time. Treat all numbers below as diagnostic only; do not use them as expected returns or deployment evidence. A data-backed replay requires timestamped Kalshi executable book snapshots, quote sizes, latency, cancellations, actual fees, and settlement outcomes.

# Backtest Findings

## Key Results (7-day synthetic GBM simulation)

| Config | Win Rate | P&L | Avg Win | Avg Loss | Verdict |
|--------|----------|-----|---------|----------|---------|
| Default (Kelly 0.25, MaxPos $25, MaxPrice 88c) | 72% | -$99 | +$0.33 | -$3.85 | Over-betting destroys bankroll |
| Conservative (Kelly 0.08, MaxPos $3, MinDiv 12%) | 82% | -$17 | +$0.17 | -$1.57 | Losses still 9x wins |
| Flat 1-contract (MinDiv 10%) | 79% | -$20 | +$0.08 | -$0.84 | Pure signal quality: negative EV |

## Root Cause Analysis

### 1. GBM Model Overconfidence (~6% bias)
The model says P(UP) = 85% when actual settlement frequency is ~79%. This systematic overconfidence means the "edge" is smaller than calculated.

### 2. Binary Payoff Asymmetry at High Entry Prices
| Entry Price | Win Payout | Required WR | Actual WR | EV per Trade |
|-------------|-----------|-------------|-----------|--------------|
| 50c | +$0.43 | 53.8% | ~75% | +$0.20 |
| 55c | +$0.38 | 59.1% | ~77% | +$0.18 |
| 65c | +$0.28 | 69.9% | ~80% | +$0.08 |
| 75c | +$0.18 | 80.6% | ~82% | +$0.01 |
| 85c | +$0.08 | 91.4% | ~84% | -$0.07 |

**Conclusion: Contracts above 65c are unprofitable even with 80%+ win rate.**

### 3. Kelly Criterion Amplifies Binary Option Losses
When a trade loses, the full position cost is lost (unlike equity where you lose a percentage). Kelly over-betting leads to outsized losses that multiple small wins can't recover from.

## Recommended Parameter Changes

```
MAX_CONTRACT_PRICE: 65  (was 88) — Reject high-price low-payoff contracts
MIN_CONTRACT_PRICE: 35  (was 48) — Allow cheap high-payoff contracts
MIN_DIVERGENCE: 15.0    (was 10) — Only trade when edge is clearly real
KELLY_FRACTION: 0.08    (was 0.25) — Much more conservative sizing
MAX_POSITION_SIZE: 5    (was 25) — Cap downside per trade
```

## Where ML Pipeline Helps

1. **Calibration correction**: ML model learns the actual win rate for each model confidence level, correcting the 6% overconfidence bias
2. **Signal filtering**: Block signals where historical data shows poor outcomes
3. **Adaptive sizing**: Adjust position size based on ML confidence, not just Kelly
4. **RAG context**: Use recent trade outcomes to adapt to changing market regimes

## Running the Backtest

```bash
npm run backtest              # Default 7-day backtest
npm run backtest:verbose      # Show individual trades
npm run backtest:30d          # 30-day backtest

# With parameter presets:
node backtest/backtest.js --optimal     # Recommended settings
node backtest/backtest.js --conservative
node backtest/backtest.js --flat        # 1-contract flat sizing
```
