'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, applyDelta, executableQuotes, hasSequenceGap } = require('../lib/kalshi-orderbook');

test('normalizes websocket snapshot and derives complementary executable asks', () => {
  const book = normalizeSnapshot({
    type: 'orderbook_snapshot', sid: 4, seq: 7,
    msg: {
      market_ticker: 'KXBTC15M-TEST',
      yes_dollars_fp: [['0.4200', '12.50'], ['0.4000', '4.00']],
      no_dollars_fp: [['0.5500', '9.00']],
    },
  });
  assert.equal(book.ticker, 'KXBTC15M-TEST');
  const quotes = executableQuotes(book);
  assert.deepEqual({ yesBid: quotes.yesBid, yesAsk: quotes.yesAsk, noBid: quotes.noBid, noAsk: quotes.noAsk }, {
    yesBid: { price: 0.42, quantity: 12.5 },
    yesAsk: { price: 0.45, quantity: 9 },
    noBid: { price: 0.55, quantity: 9 },
    noAsk: { price: 0.58, quantity: 12.5 },
  });
  assert.deepEqual(quotes.depth.yesAsks, [
    { price: 0.45, quantity: 9 },
  ]);
  assert.deepEqual(quotes.depth.noAsks, [
    { price: 0.58, quantity: 12.5 },
    { price: 0.6, quantity: 4 },
  ]);
});

test('applies size deltas, removes empty levels, and retains sequence', () => {
  const book = normalizeSnapshot({ msg: { market_ticker: 'M', yes_dollars_fp: [['0.4200', '10']], no_dollars_fp: [] } });
  applyDelta(book, { seq: 8, msg: { side: 'yes', price_dollars: '0.4200', delta_fp: '-3.25' } });
  assert.equal(book.yes[0].quantity, 6.75);
  applyDelta(book, { seq: 9, msg: { side: 'yes', price_dollars: '0.4200', delta_fp: '-6.75' } });
  assert.equal(book.yes.length, 0);
  assert.equal(book.seq, 9);
});

test('flags sequence gaps so replay can invalidate a book until a fresh snapshot', () => {
  assert.equal(hasSequenceGap(10, 11), false);
  assert.equal(hasSequenceGap(10, 12), true);
  assert.equal(hasSequenceGap(null, 1), false);
});
