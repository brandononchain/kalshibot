'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KalshiSubscriptionManager } = require('../lib/kalshi-subscriptions');

function setup() {
  const calls = [];
  const manager = new KalshiSubscriptionManager({
    isOpen: ws => ws.open,
    subscribe: (ws, channel, tickers) => calls.push({ type: 'subscribe', channel, tickers: [...tickers] }),
    update: (ws, sid, tickers, action) => calls.push({ type: 'update', sid, tickers: [...tickers], action }),
  });
  return { manager, calls };
}

test('markets discovered after socket open trigger initial subscriptions', () => {
  const { manager, calls } = setup();
  const ws = { open: true };
  manager.setSocket(ws);
  manager.setMarkets(['MKT-A']);
  assert.deepEqual(calls, [
    { type: 'subscribe', channel: 'orderbook_delta', tickers: ['MKT-A'] },
    { type: 'subscribe', channel: 'trade', tickers: ['MKT-A'] },
  ]);
});

test('markets discovered before socket open are subscribed when it opens', () => {
  const { manager, calls } = setup();
  manager.setMarkets(['MKT-A']);
  manager.setSocket({ open: true });
  assert.equal(calls.length, 2);
});

test('discovery changes during subscription acknowledgement are reconciled', () => {
  const { manager, calls } = setup();
  manager.setSocket({ open: true });
  manager.setMarkets(['MKT-A']);
  manager.setMarkets(['MKT-A', 'MKT-B']);
  manager.subscribed('orderbook_delta', 5);
  assert.deepEqual(calls.at(-1), { type: 'update', sid: 5, tickers: ['MKT-B'], action: 'add_markets' });
});

test('acknowledged channels receive additions and removals; reconnect subscribes desired set', () => {
  const { manager, calls } = setup();
  const ws = { open: true };
  manager.setMarkets(['MKT-A']);
  manager.setSocket(ws);
  manager.subscribed('orderbook_delta', 5);
  manager.subscribed('trade', 6);
  manager.setMarkets(['MKT-B']);
  assert.equal(calls.filter(call => call.type === 'update').length, 4);
  manager.closed(ws);
  manager.setSocket({ open: true });
  assert.deepEqual(calls.slice(-2).map(call => call.tickers), [['MKT-B'], ['MKT-B']]);
});
