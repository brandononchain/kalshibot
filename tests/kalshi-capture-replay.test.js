'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { KalshiCaptureReplay } = require('../lib/kalshi-capture-replay');
const { replay } = require('../scripts/replay-kalshi-capture');

function row(type, payload, extra = {}) {
  return { schema_version: 1, type, series_ticker: 'KXBTC15M', received_at_ms: 1000, payload, ...extra };
}

function snapshot(ticker, sid, seq, yes = [['0.4200', '10']], no = [['0.5500', '8']]) {
  return row('kalshi_ws', {
    type: 'orderbook_snapshot', sid, seq,
    msg: { market_ticker: ticker, yes_dollars_fp: yes, no_dollars_fp: no },
  });
}

function delta(ticker, sid, seq, side = 'yes', price = '0.4200', size = '-1') {
  return row('kalshi_ws', {
    type: 'orderbook_delta', sid, seq,
    msg: { market_ticker: ticker, side, price_dollars: price, delta_fp: size, ts_ms: 1001 },
  });
}

test('replays snapshots and only contiguous deltas into executable quote rows', () => {
  const replayEngine = new KalshiCaptureReplay();
  const snapshotOutput = replayEngine.consume(snapshot('MKT-A', 4, 10));
  assert.equal(snapshotOutput[0].type, 'replay_quote');
  assert.equal(snapshotOutput[0].quotes.yesBid.price, 0.42);

  const deltaOutput = replayEngine.consume(delta('MKT-A', 4, 11, 'yes', '0.4200', '-3'));
  assert.equal(deltaOutput[0].type, 'replay_quote');
  assert.equal(deltaOutput[0].seq, 11);
  assert.equal(deltaOutput[0].quotes.yesBid.quantity, 7);
  assert.equal(replayEngine.stats.acceptedDeltas, 1);
});

test('a gap invalidates all books on that orderbook SID until each gets a fresh snapshot', () => {
  const replayEngine = new KalshiCaptureReplay();
  replayEngine.consume(snapshot('MKT-A', 4, 10));
  replayEngine.consume(snapshot('MKT-B', 4, 11));
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 12))[0].type, 'replay_quote');

  const gap = replayEngine.consume(delta('MKT-B', 4, 14));
  assert.equal(gap[0].kind, 'sequence_gap');
  assert.deepEqual(replayEngine.summary().valid_books_at_end, []);

  assert.equal(replayEngine.consume(delta('MKT-A', 4, 15))[0].kind, 'delta_without_valid_snapshot');
  assert.equal(replayEngine.consume(snapshot('MKT-A', 4, 16))[0].type, 'replay_quote');
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 17))[0].type, 'replay_quote');
  assert.deepEqual(replayEngine.summary().valid_books_at_end.map(book => book.ticker), ['MKT-A']);
  assert.equal(replayEngine.stats.sequenceGaps, 1);
  assert.equal(replayEngine.stats.markets['MKT-A'].recoveries, 1);
});

test('a snapshot sequence jump restores only its market and invalidates other books on that SID', () => {
  const replayEngine = new KalshiCaptureReplay();
  replayEngine.consume(snapshot('MKT-A', 4, 10));
  replayEngine.consume(snapshot('MKT-B', 4, 11));

  const output = replayEngine.consume(snapshot('MKT-B', 4, 13));
  assert.equal(output[0].type, 'replay_quote');
  assert.equal(output[1].kind, 'snapshot_sequence_gap');
  assert.deepEqual(replayEngine.summary().valid_books_at_end.map(book => book.ticker), ['MKT-B']);
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 14))[0].kind, 'delta_without_valid_snapshot');
  assert.equal(replayEngine.consume(delta('MKT-B', 4, 15))[0].type, 'replay_quote');
});

test('a snapshot without a sequence invalidates the entire identified stream', () => {
  const replayEngine = new KalshiCaptureReplay();
  replayEngine.consume(snapshot('MKT-A', 4, 10));
  const invalid = replayEngine.consume(row('kalshi_ws', {
    type: 'orderbook_snapshot', sid: 4, seq: null,
    msg: { market_ticker: 'MKT-B', yes_dollars_fp: [['0.4', '1']], no_dollars_fp: [] },
  }));
  assert.equal(invalid[0].kind, 'invalid_snapshot');
  assert.deepEqual(replayEngine.summary().valid_books_at_end, []);
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 11))[0].kind, 'sequence_baseline_missing');
});

test('trade-channel gaps do not invalidate a separate valid orderbook stream', () => {
  const replayEngine = new KalshiCaptureReplay();
  replayEngine.consume(snapshot('MKT-A', 4, 10));
  replayEngine.consume(row('kalshi_ws', { type: 'subscribed', msg: { sid: 9, channel: 'trade' } }));
  replayEngine.consume(row('kalshi_ws', { type: 'trade', sid: 9, seq: 1, msg: {} }));
  const diagnostics = replayEngine.consume(row('kalshi_ws', { type: 'trade', sid: 9, seq: 3, msg: {} }));
  assert.equal(diagnostics[0].kind, 'channel_sequence_gap');
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 11))[0].type, 'replay_quote');
  assert.deepEqual(replayEngine.summary().valid_books_at_end.map(book => book.ticker), ['MKT-A']);
});

test('a Kalshi reconnect invalidates old books and requires new snapshots', () => {
  const replayEngine = new KalshiCaptureReplay();
  replayEngine.consume(snapshot('MKT-A', 4, 10));
  replayEngine.consume(row('connection', { service: 'kalshi', status: 'disconnected' }));
  assert.equal(replayEngine.consume(delta('MKT-A', 4, 11))[0].kind, 'sequence_baseline_missing');
  assert.equal(replayEngine.consume(snapshot('MKT-A', 4, 1))[0].type, 'replay_quote');
  assert.equal(replayEngine.stats.disconnects, 1);
});

test('CLI replay streams capture files, reports malformed rows, and writes separate outputs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kalshi-replay-'));
  const input = path.join(directory, 'capture.jsonl');
  const quotesPath = path.join(directory, 'out', 'quotes.jsonl');
  const summaryPath = path.join(directory, 'out', 'summary.json');
  const records = [snapshot('MKT-A', 4, 10), delta('MKT-A', 4, 11, 'yes', '0.4200', '-2')];
  await fs.writeFile(input, `${records.map(value => JSON.stringify(value)).join('\n')}\nnot-json\n`);

  const summary = await replay({ inputs: [input], quotesPath, summaryPath });
  const quoteLines = (await fs.readFile(quotesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const savedSummary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
  assert.equal(quoteLines.filter(value => value.type === 'replay_quote').length, 2);
  assert.equal(quoteLines.filter(value => value.type === 'replay_diagnostic').length, 1);
  assert.equal(summary.stats.malformedRecords, 1);
  assert.equal(savedSummary.stats.acceptedDeltas, 1);
  assert.equal(savedSummary.stats.malformedRecords, 1);
  assert.equal(savedSummary.valid_books_at_end.length, 0);
});
