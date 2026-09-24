#!/usr/bin/env node
'use strict';

// Data-only capture process. It never places, modifies, or cancels orders.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const KalshiClient = require('../bot/kalshi');
const { normalizeSnapshot, applyDelta, executableQuotes, hasSequenceGap } = require('../lib/kalshi-orderbook');

const seriesTicker = process.env.CAPTURE_SERIES_TICKER || process.env.SERIES_TICKER || 'KXBTC15M';
const binanceSymbol = (process.env.CAPTURE_BINANCE_SYMBOL || 'btcusdt').toLowerCase();
const intervalMs = Math.max(1000, Number(process.env.CAPTURE_DISCOVERY_INTERVAL_MS || 10000));
const outputDir = path.resolve(process.env.CAPTURE_OUTPUT_DIR || './data/captures');
const stopAfterMinutes = Number(process.env.CAPTURE_DURATION_MINUTES || 0);
const requestedMaxBytes = Number(process.env.CAPTURE_MAX_BYTES || 128 * 1024 * 1024);
const reserveBytes = Number(process.env.CAPTURE_DISK_RESERVE_BYTES || 64 * 1024 * 1024);
const maxQueuedBytes = Number(process.env.CAPTURE_MAX_QUEUED_BYTES || 4 * 1024 * 1024);
const startTime = Date.now();

if (!process.env.KALSHI_API_KEY) {
  console.error('Missing KALSHI_API_KEY. Set it locally in .env; do not paste credentials into chat or commit them.');
  process.exit(2);
}

const config = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com',
};
const client = new KalshiClient(config, {});
try { client.loadPrivateKey(); } catch (error) {
  console.error(error.message);
  process.exit(2);
}

fs.mkdirSync(outputDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.join(outputDir, `kalshi-${seriesTicker}-${runId}.jsonl`);
const output = fs.createWriteStream(outputPath, { flags: 'wx' });
const requestedBudget = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
  ? requestedMaxBytes : 128 * 1024 * 1024;
const diskReserve = Number.isFinite(reserveBytes) && reserveBytes >= 0
  ? reserveBytes : 64 * 1024 * 1024;
const queueLimit = Number.isFinite(maxQueuedBytes) && maxQueuedBytes > 0
  ? maxQueuedBytes : 4 * 1024 * 1024;
let diskBudget = 0;
try {
  const stats = fs.statfsSync(outputDir);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  diskBudget = Math.max(0, Math.min(requestedBudget, freeBytes - diskReserve));
} catch (error) {
  console.error(`Unable to check capture disk space: ${error.message}`);
}
let stopping = false;
let outputFailed = false;
let outputEnded = false;
let outputBlocked = false;
let finishRequested = false;
let outputBytes = 0;
let queuedBytes = 0;
const writeQueue = [];
let stopCapture = null;
let discoveryTimer = null;
let durationTimer = null;
let kalshiWs;
let binanceWs;
let kalshiRetryMs = 1000;
let binanceRetryMs = 1000;
let nextCommandId = 1;
let bookSid = null;
let tradeSid = null;
let discovered = new Map();
let discoveryInFlight = false;
let pendingSettlement = new Map();
let settlementRetryAt = new Map();
let bookStates = new Map();
let lastSequences = new Map();
let binancePrices = [];

function pauseFeeds() {
  for (const ws of [kalshiWs, binanceWs]) {
    if (ws && typeof ws.pause === 'function') ws.pause();
  }
}

function resumeFeeds() {
  if (stopping) return;
  for (const ws of [kalshiWs, binanceWs]) {
    if (ws && typeof ws.resume === 'function') ws.resume();
  }
}

function finishOutputIfReady() {
  if (!finishRequested || outputEnded || outputFailed || outputBlocked || writeQueue.length) return;
  outputEnded = true;
  output.end(() => console.log(`Capture saved: ${outputPath}`));
}

function flushOutputQueue() {
  outputBlocked = false;
  while (writeQueue.length) {
    const line = writeQueue.shift();
    queuedBytes -= Buffer.byteLength(line);
    if (!output.write(line)) {
      outputBlocked = true;
      pauseFeeds();
      return;
    }
  }
  resumeFeeds();
  finishOutputIfReady();
}

output.on('drain', flushOutputQueue);
output.on('error', error => {
  outputFailed = true;
  console.error(`Capture output failed (${error.code || 'write error'}): ${error.message}`);
  if (stopCapture) stopCapture('output_error');
});

function writeLine(line) {
  if (outputFailed || outputEnded) return false;
  const bytes = Buffer.byteLength(line);
  if (outputBytes + bytes > diskBudget) {
    if (stopCapture) stopCapture('disk_budget_reached');
    return false;
  }
  if (outputBlocked || writeQueue.length) {
    if (queuedBytes + bytes > queueLimit) {
      if (stopCapture) stopCapture('write_queue_limit_reached');
      return false;
    }
    writeQueue.push(line);
    queuedBytes += bytes;
    outputBytes += bytes;
    return true;
  }
  outputBytes += bytes;
  if (!output.write(line)) {
    outputBlocked = true;
    pauseFeeds();
  }
  return true;
}

function writeEvent(type, payload, sourceTs = null, receivedAt = Date.now()) {
  if (outputFailed || outputEnded || (stopping && type !== 'capture_stopped')) return false;
  const record = { schema_version: 1, type, series_ticker: seriesTicker, source_ts_ms: sourceTs, received_at_ms: receivedAt, payload };
  return writeLine(`${JSON.stringify(record)}\n`);
}

function marketTickerFrom(raw) { return raw.market_ticker || raw.ticker || null; }

function logMarket(raw, receivedAt) {
  const ticker = marketTickerFrom(raw);
  if (!ticker) return;
  const openAt = Date.parse(raw.open_time || raw.openTime || '');
  let referenceAtOpen = null;
  if (Number.isFinite(openAt)) {
    let best = null;
    for (const quote of binancePrices) {
      const distance = Math.abs(quote.sourceTsMs - openAt);
      if (distance <= 2500 && (!best || distance < best.distance)) best = { ...quote, distance };
    }
    if (best) referenceAtOpen = { price: (best.bid + best.ask) / 2, source_ts_ms: best.sourceTsMs, distance_ms: best.distance };
  }
  writeEvent('market_metadata', { ...raw, reference_at_open: referenceAtOpen }, null, receivedAt);
}

function wsUrl() {
  if (process.env.KALSHI_WS_URL) return process.env.KALSHI_WS_URL;
  if (config.KALSHI_API_BASE.includes('external-api.kalshi.com')) return 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
  if (config.KALSHI_API_BASE.includes('demo')) return 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2';
  return `${config.KALSHI_API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/trade-api/ws/v2`;
}

function sendSubscribe(ws, channels, tickers) {
  if (!ws || ws.readyState !== WebSocket.OPEN || tickers.length === 0) return;
  const id = nextCommandId++;
  ws.send(JSON.stringify({ id, cmd: 'subscribe', params: { channels, market_tickers: tickers } }));
}

function updateSubscription(ws, sid, tickers, action) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !Number.isInteger(sid) || tickers.length === 0) return;
  ws.send(JSON.stringify({
    id: nextCommandId++,
    cmd: 'update_subscription',
    params: { sids: [sid], market_tickers: tickers, action },
  }));
}

function connectKalshi() {
  if (stopping) return;
  const auth = client.generateAuth('GET', '/trade-api/ws/v2').headers;
  kalshiWs = new WebSocket(wsUrl(), { headers: auth, handshakeTimeout: 15000 });
  kalshiWs.on('open', () => {
    kalshiRetryMs = 1000;
    writeEvent('connection', { service: 'kalshi', status: 'connected', url: wsUrl() });
    const tickers = [...discovered.keys()];
    if (tickers.length) {
      sendSubscribe(kalshiWs, ['orderbook_delta'], tickers);
      sendSubscribe(kalshiWs, ['trade'], tickers);
    }
  });
  kalshiWs.on('message', raw => {
    const receivedAt = Date.now();
    let message;
    try { message = JSON.parse(raw.toString()); } catch (error) {
      writeEvent('parse_error', { service: 'kalshi', message: error.message, raw: raw.toString() }, null, receivedAt);
      return;
    }
    if (message.type === 'subscribed' && message.msg?.channel === 'orderbook_delta') bookSid = message.msg.sid;
    if (message.type === 'subscribed' && message.msg?.channel === 'trade') tradeSid = message.msg.sid;
    const ticker = message.msg?.market_ticker;
    if (message.type === 'orderbook_snapshot' && ticker) {
      bookStates.set(ticker, normalizeSnapshot(message));
      if (Number.isInteger(message.sid) && Number.isInteger(message.seq)) lastSequences.set(message.sid, message.seq);
    } else if (message.type === 'orderbook_delta' && ticker) {
      const previous = lastSequences.get(message.sid);
      if (hasSequenceGap(previous, message.seq)) {
        writeEvent('sequence_gap', { ticker, sid: message.sid, previous_seq: previous, current_seq: message.seq });
        bookStates.delete(ticker);
        if (kalshiWs.readyState === WebSocket.OPEN) {
          kalshiWs.send(JSON.stringify({ id: nextCommandId++, cmd: 'update_subscription', params: { sids: [message.sid], market_tickers: [ticker], action: 'get_snapshot' } }));
        }
      } else if (bookStates.has(ticker)) {
        try { applyDelta(bookStates.get(ticker), message); } catch (error) {
          writeEvent('book_apply_error', { ticker, error: error.message, message });
          bookStates.delete(ticker);
        }
      }
      if (Number.isInteger(message.seq)) lastSequences.set(message.sid, message.seq);
      if (bookStates.has(ticker)) writeEvent('derived_quote', { ticker, quotes: executableQuotes(bookStates.get(ticker)), book_seq: message.seq }, message.msg?.ts_ms || null, receivedAt);
    }
    const sourceTs = Number(message.msg?.ts_ms) || (message.msg?.created_time ? Date.parse(message.msg.created_time) : null);
    writeEvent('kalshi_ws', message, Number.isFinite(sourceTs) ? sourceTs : null, receivedAt);
  });
  kalshiWs.on('error', error => writeEvent('connection_error', { service: 'kalshi', error: error.message }));
  kalshiWs.on('close', (code, reason) => {
    bookSid = tradeSid = null;
    lastSequences.clear();
    bookStates.clear();
    writeEvent('connection', { service: 'kalshi', status: 'disconnected', code, reason: reason.toString() });
    if (!stopping) {
      const delay = kalshiRetryMs;
      kalshiRetryMs = Math.min(kalshiRetryMs * 2, 30000);
      setTimeout(connectKalshi, delay);
    }
  });
}

function connectBinance() {
  if (stopping) return;
  const url = `wss://stream.binance.com:9443/ws/${binanceSymbol}@bookTicker`;
  binanceWs = new WebSocket(url);
  binanceWs.on('open', () => {
    binanceRetryMs = 1000;
    writeEvent('connection', { service: 'binance', status: 'connected', symbol: binanceSymbol });
  });
  binanceWs.on('message', raw => {
    const receivedAt = Date.now();
    try {
      const message = JSON.parse(raw.toString());
      const bid = Number(message.b), ask = Number(message.a);
      if (!(bid > 0 && ask >= bid)) return;
      const sourceTs = Number(message.E || message.T || receivedAt);
      const quote = { symbol: message.s || binanceSymbol.toUpperCase(), bid, ask, bid_size: Number(message.B), ask_size: Number(message.A) };
      binancePrices.push({ sourceTsMs: sourceTs, bid, ask });
      const oldest = receivedAt - 120000;
      binancePrices = binancePrices.filter(item => item.sourceTsMs >= oldest).slice(-5000);
      writeEvent('binance_book_ticker', quote, sourceTs, receivedAt);
    } catch (error) {
      writeEvent('parse_error', { service: 'binance', error: error.message }, null, receivedAt);
    }
  });
  binanceWs.on('error', error => writeEvent('connection_error', { service: 'binance', error: error.message }));
  binanceWs.on('close', (code, reason) => {
    writeEvent('connection', { service: 'binance', status: 'disconnected', code, reason: reason.toString() });
    if (!stopping) {
      const delay = binanceRetryMs;
      binanceRetryMs = Math.min(binanceRetryMs * 2, 30000);
      setTimeout(connectBinance, delay);
    }
  });
}

async function refreshMarkets() {
  if (discoveryInFlight || stopping) return;
  discoveryInFlight = true;
  try {
    const markets = await client.discoverMarkets(seriesTicker);
    const next = new Map(markets.filter(m => m.status === 'active' || m.status === 'open').map(m => [m.ticker, m]));
    const now = Date.now();
    for (const [ticker, market] of next) {
      if (!discovered.has(ticker)) logMarket(market, now);
    }
    const before = new Set(discovered.keys());
    const after = new Set(next.keys());
    if (kalshiWs?.readyState === WebSocket.OPEN) {
      const add = [...after].filter(ticker => !before.has(ticker));
      const remove = [...before].filter(ticker => !after.has(ticker));
      if (add.length) {
        updateSubscription(kalshiWs, bookSid, add, 'add_markets');
        updateSubscription(kalshiWs, tradeSid, add, 'add_markets');
      }
      if (remove.length) {
        updateSubscription(kalshiWs, bookSid, remove, 'delete_markets');
        updateSubscription(kalshiWs, tradeSid, remove, 'delete_markets');
      }
    }
    for (const [ticker, market] of discovered) {
      if (!next.has(ticker)) pendingSettlement.set(ticker, market);
    }
    discovered = next;
    await refreshSettlements();
    writeEvent('market_universe', { tickers: [...after], count: after.size }, null, now);
  } catch (error) {
    writeEvent('capture_error', { stage: 'market_discovery', error: error.response?.data || error.message });
  } finally {
    discoveryInFlight = false;
  }
}

async function refreshSettlements() {
  const now = Date.now();
  const due = [...pendingSettlement.keys()].filter(ticker => (settlementRetryAt.get(ticker) || 0) <= now).slice(0, 5);
  for (const ticker of due) {
    settlementRetryAt.set(ticker, now + 30000);
    try {
      const market = await client.fetchMarket(ticker);
      if (!market) continue;
      if (market.result === 'yes' || market.result === 'no') {
        writeEvent('market_settlement', market, null, Date.now());
        pendingSettlement.delete(ticker);
        settlementRetryAt.delete(ticker);
      } else {
        const prior = pendingSettlement.get(ticker) || {};
        const closeAt = Number(prior.closeTime) || Date.parse(prior.close_time || '');
        if (Number.isFinite(closeAt) && now - closeAt > 7 * 86400000) {
          // Keep the capture bounded when the exchange no longer returns an outcome.
          pendingSettlement.delete(ticker);
          settlementRetryAt.delete(ticker);
        }
      }
    } catch (error) {
      writeEvent('capture_error', { stage: 'settlement_lookup', ticker, error: error.response?.data || error.message });
    }
  }
}

function stopCaptureNow(reason = 'requested') {
  if (stopping) return;
  stopping = true;
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (durationTimer) clearTimeout(durationTimer);
  if (reason !== 'requested') console.error(`Stopping capture safely: ${reason}`);
  writeEvent('capture_stopped', { elapsed_ms: Date.now() - startTime, reason });
  for (const ws of [kalshiWs, binanceWs]) {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  }
  finishRequested = true;
  finishOutputIfReady();
}

stopCapture = stopCaptureNow;

async function main() {
  if (diskBudget <= 0) {
    stopCapture('disk_reserve_reached');
    return;
  }
  console.log(`Capturing ${seriesTicker} event markets and ${binanceSymbol.toUpperCase()} reference quotes to ${outputPath} (max ${diskBudget} bytes)`);
  console.log('Data-only: this process has no order-placement or cancellation calls. Press Ctrl+C to stop.');
  process.on('SIGINT', () => stopCapture('requested'));
  process.on('SIGTERM', () => stopCapture('requested'));
  writeEvent('capture_started', { series_ticker: seriesTicker, binance_symbol: binanceSymbol, interval_ms: intervalMs });
  if (stopping) return;
  connectKalshi();
  connectBinance();
  await refreshMarkets();
  if (stopping) return;
  discoveryTimer = setInterval(refreshMarkets, intervalMs);
  durationTimer = stopAfterMinutes > 0 ? setTimeout(() => stopCapture('duration_limit_reached'), stopAfterMinutes * 60000) : null;
}
main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
