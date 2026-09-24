# Kalshi event-market history capture

This collector records real Kalshi event-market order-book snapshots and deltas, public trades, market metadata and outcomes, plus Binance BTC best-bid/ask observations for the existing `KXBTC15M` strategy. It is data-only: it has no order placement, amendment, or cancellation path.

## Configure credentials locally

Use a Kalshi API key and private key on the machine that will run the collector. Keep both in a local `.env` or an untracked secret store; never commit them or paste the private key into chat.

```dotenv
KALSHI_API_KEY=your-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem
KALSHI_API_BASE=https://external-api.kalshi.com
```

The key must have permission to read market data and establish an authenticated WebSocket. The collector only calls market discovery and market-detail GET endpoints and subscribes to the `orderbook_delta` and `trade` channels. It does not call portfolio order endpoints.

## Run

```bash
node scripts/capture-kalshi-history.js
```

By default it captures `KXBTC15M` and BTC/USDT quotes continuously into `data/captures/kalshi-KXBTC15M-YYYY-MM-DD.jsonl`. Stop with Ctrl+C. Optional settings:

```dotenv
CAPTURE_SERIES_TICKER=KXBTC15M
CAPTURE_BINANCE_SYMBOL=btcusdt
CAPTURE_DISCOVERY_INTERVAL_MS=10000
CAPTURE_OUTPUT_DIR=./data/captures
CAPTURE_DURATION_MINUTES=0
```

`CAPTURE_DURATION_MINUTES=0` means keep running until stopped. Keep the computer awake and the process running for continuous coverage. The collector reconnects to both WebSockets after disconnects and records connection errors and gaps.

## Event format

Each NDJSON row has a `schema_version`, event `type`, UTC millisecond timestamps, and a `payload`. Event types include:

- `market_metadata` and `market_settlement`
- `kalshi_ws` with the untouched Kalshi snapshot, delta, or trade message, including exchange sequence IDs and source timestamps when provided
- `derived_quote` with executable YES/NO bid and ask levels reconstructed from the latest valid order-book state
- `binance_book_ticker` with Binance best bid/ask and sizes
- `sequence_gap`, `connection`, and `capture_error` diagnostics

The collector marks sequence gaps and requests a fresh book snapshot. A replay must treat the book as invalid between a gap and its replacement snapshot; it must not fill orders from a stale reconstructed book. Binance observations are a BTC spot proxy, not Kalshi's settlement benchmark. Where a captured quote is within 2.5 seconds of a market's scheduled open, the metadata row records it as a candidate open reference; otherwise that reference remains null and the market must be excluded from strategies that require an opening price.

These files build a prospective high-resolution dataset from the time capture begins. They do not backfill historical order-book depth, queue position, or missed data during downtime. Preserve the files and share a sample before relying on them for a backtest. Historical Kalshi trade and settlement endpoints or a Lychee export can extend event/outcome analysis, but trades alone cannot reconstruct the order book.
