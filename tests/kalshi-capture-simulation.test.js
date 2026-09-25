'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { simulate } = require('../scripts/simulate-kalshi-capture');

const ticker = 'KXBTC15M-TEST';
const open = 1_000_000;
const close = open + 900_000;

function row(type, payload, receivedAt) {
  return { schema_version: 1, type, series_ticker: 'KXBTC15M', received_at_ms: receivedAt, payload };
}

function fixture({ outcome = 'yes', includeSnapshot = true } = {}) {
  const rows = [row('market_metadata', {
    ticker, open_time: open, close_time: close,
    reference_at_open: { price: 100, source_ts_ms: open, distance_ms: 0 },
  }, open)];
  for (let i = 1; i <= 10; i++) rows.push(row('binance_book_ticker', { bid: 101.99, ask: 102.01 }, open + i * 1000));
  if (includeSnapshot) rows.push(row('kalshi_ws', {
    type: 'orderbook_snapshot', sid: 7, seq: 10,
    msg: { market_ticker: ticker, yes_dollars_fp: [['0.49', '10']], no_dollars_fp: [['0.50', '10']] },
  }, open + 11_000));
  if (includeSnapshot) rows.push(row('kalshi_ws', {
    type: 'orderbook_delta', sid: 7, seq: 11,
    msg: { market_ticker: ticker, side: 'no', price_dollars: '0.5000', delta_fp: '2' },
  }, open + 12_000));
  if (outcome) rows.push(row('market_settlement', { ticker, result: outcome }, close + 1000));
  return rows;
}

async function writeCapture(rows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kalshi-paper-sim-'));
  const input = path.join(directory, 'capture.jsonl');
  await fs.writeFile(input, `${rows.map(record => JSON.stringify(record)).join('\n')}\n`);
  return { directory, input };
}

test('simulates a real-book entry with fees, adverse slippage, and settlement, without live orders', async () => {
  const { directory, input } = await writeCapture(fixture());
  const summary = await simulate({ input });
  const rows = (await fs.readFile(path.join(directory, 'capture.paper-trades.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(summary.stats.candidateSignals, 1);
  assert.equal(summary.stats.filledTrades, 1);
  assert.equal(summary.stats.resolvedTrades, 1);
  assert.equal(summary.stats.wins, 1);
  assert.equal(summary.replay.acceptedDeltas, 1);
  assert.equal(summary.validBooksAtEnd, 1);
  assert.equal(rows[0].side, 'yes');
  assert.equal(rows[0].entry_price, 0.51);
  assert.equal(rows[0].settlement, 'yes');
  assert.ok(rows[0].net_pnl > 0);
});

test('does not create fills without a valid snapshot-backed book', async () => {
  const { input } = await writeCapture(fixture({ includeSnapshot: false }));
  const summary = await simulate({ input });
  assert.equal(summary.stats.filledTrades, 0);
  assert.equal(summary.stats.resolvedTrades, 0);
  assert.equal(summary.validBooksAtEnd, 0);
});

test('keeps trades unresolved when the capture has no settlement label', async () => {
  const { directory, input } = await writeCapture(fixture({ outcome: null }));
  const summary = await simulate({ input });
  const rows = (await fs.readFile(path.join(directory, 'capture.paper-trades.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(summary.stats.filledTrades, 1);
  assert.equal(summary.stats.resolvedTrades, 0);
  assert.equal(summary.unresolved_trade_count, 1);
  assert.equal(rows[0].settlement, null);
});
