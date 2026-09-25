'use strict';

const CHANNELS = ['orderbook_delta', 'trade'];

class KalshiSubscriptionManager {
  constructor({ isOpen, subscribe, update }) {
    this.isOpen = isOpen;
    this.subscribe = subscribe;
    this.update = update;
    this.desired = new Set();
    this.channels = new Map(CHANNELS.map(channel => [channel, {
      sid: null, pending: false, tickers: new Set(),
    }]));
    this.ws = null;
    this.initialTickers = new Map();
  }

  setSocket(ws) {
    this.ws = ws;
    this.initialTickers = new Map();
    for (const state of this.channels.values()) {
      state.sid = null;
      state.pending = false;
      state.tickers.clear();
    }
    this.sync();
  }

  setMarkets(tickers) {
    this.desired = new Set(tickers);
    this.sync();
  }

  subscribed(channel, sid) {
    const state = this.channels.get(channel);
    if (!state || !Number.isInteger(sid)) return;
    state.sid = sid;
    state.pending = false;
    state.tickers = new Set(this.initialTickers.get(channel) || this.desired);
    this.sync();
  }

  closed(ws) {
    if (ws && ws !== this.ws) return;
    this.ws = null;
    this.initialTickers = new Map();
    for (const state of this.channels.values()) {
      state.sid = null;
      state.pending = false;
      state.tickers.clear();
    }
  }

  sync() {
    if (!this.ws || !this.isOpen(this.ws) || this.desired.size === 0) return;
    for (const [channel, state] of this.channels) {
      if (state.sid === null) {
        if (!state.pending) {
          const tickers = [...this.desired];
          this.subscribe(this.ws, channel, tickers);
          state.pending = true;
          this.initialTickers.set(channel, tickers);
        }
        continue;
      }
      const add = [...this.desired].filter(ticker => !state.tickers.has(ticker));
      const remove = [...state.tickers].filter(ticker => !this.desired.has(ticker));
      if (add.length) this.update(this.ws, state.sid, add, 'add_markets');
      if (remove.length) this.update(this.ws, state.sid, remove, 'delete_markets');
      add.forEach(ticker => state.tickers.add(ticker));
      remove.forEach(ticker => state.tickers.delete(ticker));
    }
  }
}

module.exports = { KalshiSubscriptionManager };
