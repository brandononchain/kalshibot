# Replaying captured Kalshi order books

`replay-kalshi-capture.js` reconstructs executable YES/NO books from the raw `kalshi_ws` rows written by `capture-kalshi-history.js`. It is offline and data-only: it does not connect to Kalshi or Binance and does not place, amend, or cancel orders.

## Run

Use one or more capture files. When using rotated files, provide them oldest to newest:

```bash
node scripts/replay-kalshi-capture.js \
  data/captures/kalshi-KXBTC15M-2026-09-24T23-15-41-937Z.jsonl \
  --quotes data/replay/quotes.jsonl \
  --summary data/replay/summary.json
```

If output paths are omitted, the tool writes `.replay-quotes.jsonl` and `.replay-summary.json` beside the first input. It streams input rows and quote output, so memory use does not grow with capture size. Output paths are checked against input paths to avoid overwriting source captures.

## Replay rules

- A book becomes usable only after a snapshot with a ticker, SID, and sequence number.
- Deltas are applied only when their SID matches that snapshot and the sequence is exactly contiguous.
- A gap invalidates every book on the affected order-book stream. Later deltas are skipped until each market receives a fresh snapshot.
- A full snapshot can restore its own market after a jump, but the jump still invalidates every other market book on that SID.
- A Kalshi disconnect invalidates all books and sequence cursors. Data from before a reconnect is never carried forward.
- Trade-channel sequence gaps are reported separately and do not invalidate an independent order-book stream.
- A malformed JSON row is treated as an unknown possibly missing update: all books are invalidated until fresh snapshots arrive. It is reported in the quote output and replay continues.

The quote output contains full executable YES/NO depth after each accepted snapshot or delta. Diagnostic rows explain rejected deltas, gaps, stale snapshots, and malformed records. The summary reports record counts, valid books at end of input, per-market replay counts, and the input file names and sizes.

## Limits

Replay validates feed continuity and reconstructs books. It does **not** simulate queue position or fills, apply fees/slippage, calculate P&L, or establish profitability. Those require a separate chronological execution model and a train/validation/test split. Any market after a sequence gap is excluded until its replacement snapshot, so missing capture coverage remains visible rather than being filled with stale quotes.
