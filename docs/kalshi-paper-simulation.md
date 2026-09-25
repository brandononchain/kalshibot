# Paper-simulating a Kalshi capture

Run the simulator against a capture after it has been saved to the Railway volume:

```bash
npm run capture:simulate -- /data/captures/<capture-file>.jsonl
```

It reconstructs books only from valid snapshots and contiguous deltas, then checks the existing directional BTC strategy at observed Kalshi book updates. It uses Binance midpoint observations available at the decision time, and requires a recorded BTC reference close to market open. It makes no exchange connection and sends no orders.

## Baseline assumptions

- One contract per market, with a $100 starting paper balance.
- One entry per market, during the first four minutes, with at least 30 seconds before close.
- Entry prices between 35¢ and 65¢, and expected value above 15¢ after fee and slippage.
- Fill only when the captured ask depth supports the position; add one cent adverse slippage per contract.
- Estimate Kalshi taker fees at 7%, then hold to the recorded settlement.
- Polymarket arbitrage and take-profit exits are excluded because this capture has no Polymarket quote history and the baseline holds to settlement.

The tool writes `.paper-trades.jsonl` and `.paper-summary.json` beside the input. Win rate and P&L use only trades with recorded settlements. Unresolved trades remain listed with unknown outcomes and their entry costs remain deducted from ending paper cash.

## Interpreting results

This is an initial event-driven paper simulation, not proof of profitability. It assumes an immediate fill against displayed depth and does not model queue position, order latency, cancellations, or adverse market movement during execution. The one-cent slippage is a configurable baseline penalty, not a calibrated fill model. Collect many independently settled markets, inspect unresolved trades and data gaps, and use chronological out-of-sample periods before calibrating or training a predictive model. Do not use the existing synthetic backtest results as validation of real-market returns.
