#!/usr/bin/env node
'use strict';

// Offline, data-only paper simulation. Reconstructs valid books from raw capture
// messages and uses only information observed by each decision timestamp.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { finished } = require('stream/promises');
const { KalshiCaptureReplay } = require('../lib/kalshi-capture-replay');
const { estimateTakerFeeDollars, expectedValuePerContract } = require('../lib/kalshi-economics');

const DEFAULTS = {
  feeRate: 0.07,
  slippagePerContract: 0.01,
  minEdge: 0.15,
  minPrice: 0.35,
  maxPrice: 0.65,
  windowMs: 4 * 60 * 1000,
  minTimeToCloseMs: 30 * 1000,
  contracts: 1,
  startingBalance: 100,
};

function normalCDF(value) {
  if (value < -8) return 0;
  if (value > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t *
    Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return 0.5 * (1 + sign * y);
}

function timeMs(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function marketTimes(payload) {
  return {
    open: timeMs(payload.openTime ?? payload.open_time),
    close: timeMs(payload.closeTime ?? payload.close_time),
  };
}

function volatilityAt(samples, now, windowSeconds) {
  const cutoff = now - windowSeconds * 1000;
  const relevant = samples.filter(sample => sample.timestamp >= cutoff && sample.timestamp <= now);
  if (relevant.length < 10) return 0.0015;
  const returns = [];
  for (let i = 1; i < relevant.length; i++) {
    returns.push(Math.log(relevant[i].price / relevant[i - 1].price));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const avgInterval = (relevant.at(-1).timestamp - relevant[0].timestamp) / (relevant.length - 1);
  if (!(avgInterval > 0)) return 0.0015;
  return Math.sqrt(variance) * Math.sqrt((windowSeconds * 1000) / avgInterval);
}

function impliedProbabilities(currentPrice, openPrice, now, openAt, closeAt, samples) {
  const totalDuration = closeAt - openAt;
  const timeRemaining = closeAt - now;
  if (!(currentPrice > 0 && openPrice > 0 && totalDuration > 0 && timeRemaining > 0)) return null;
  const move = (currentPrice - openPrice) / openPrice;
  const sigma = volatilityAt(samples, now, totalDuration / 1000);
  const remainingSigma = sigma * Math.sqrt(Math.max(0.001, timeRemaining / totalDuration));
  const probUp = remainingSigma < 0.00001 ? (move > 0 ? 0.99 : 0.01) :
    Math.max(0.01, Math.min(0.99, normalCDF(move / remainingSigma)));
  return { yes: probUp, no: 1 - probUp };
}

function fillAtAsk(levels, contracts) {
  let remaining = contracts;
  let notional = 0;
  for (const level of levels || []) {
    const take = Math.min(remaining, level.quantity);
    if (take > 0) {
      notional += take * level.price;
      remaining -= take;
    }
    if (remaining <= 1e-8) break;
  }
  if (remaining > 1e-8) return null;
  return { contracts, averagePrice: notional / contracts, notional };
}

function usage() {
  return `Offline real-capture paper simulation (no orders are sent).\n\nUsage:\n  node scripts/simulate-kalshi-capture.js <capture.jsonl> [--trades <file>] [--summary <file>]\n`;
}

function parseArgs(argv) {
  let input = null, tradesPath = null, summaryPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--trades' || arg === '--summary') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--trades') tradesPath = value;
      else summaryPath = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (input) throw new Error('Provide exactly one capture JSONL file');
    else input = arg;
  }
  if (!input) throw new Error('Provide a capture JSONL file');
  const resolvedInput = path.resolve(input);
  const stem = resolvedInput.replace(/\.jsonl$/i, '');
  return {
    help: false,
    input: resolvedInput,
    tradesPath: path.resolve(tradesPath || `${stem}.paper-trades.jsonl`),
    summaryPath: path.resolve(summaryPath || `${stem}.paper-summary.json`),
  };
}

function blankStats() {
  return {
    captureRecords: 0, captureMalformed: 0, kalshiQuotes: 0, binanceSamples: 0,
    candidateSignals: 0, filledTrades: 0, insufficientAskDepth: 0,
    missingMarketMetadata: 0, missingOpenReference: 0, missingSettlement: 0,
    resolvedTrades: 0, wins: 0, losses: 0, grossPnl: 0, fees: 0, netPnl: 0,
    endingBalance: DEFAULTS.startingBalance,
  };
}

async function simulate({ input, tradesPath, summaryPath, options = {} }) {
  const config = { ...DEFAULTS, ...options };
  const resolvedInput = path.resolve(input);
  const resolvedTrades = path.resolve(tradesPath || `${resolvedInput.replace(/\.jsonl$/i, '')}.paper-trades.jsonl`);
  const resolvedSummary = path.resolve(summaryPath || `${resolvedInput.replace(/\.jsonl$/i, '')}.paper-summary.json`);
  if ([resolvedInput].includes(resolvedTrades) || [resolvedInput].includes(resolvedSummary) || resolvedTrades === resolvedSummary) {
    throw new Error('Simulation outputs must not overwrite the input or each other');
  }
  await fs.promises.stat(resolvedInput);
  await fs.promises.mkdir(path.dirname(resolvedTrades), { recursive: true });
  await fs.promises.mkdir(path.dirname(resolvedSummary), { recursive: true });

  const tradesStream = fs.createWriteStream(resolvedTrades, { flags: 'w' });
  const replay = new KalshiCaptureReplay();
  const stats = blankStats();
  const markets = new Map();
  const binanceSamples = [];
  const held = new Set();
  const pendingTrades = new Map();
  const allTrades = [];
  let cashBalance = config.startingBalance;
  let lastBinanceSampleAt = -Infinity;
  let latestBinanceMid = null;

  const writeTrade = trade => tradesStream.write(`${JSON.stringify(trade)}\n`);
  const settleTrade = (trade, outcome) => {
    if (!trade || trade.settlement) return;
    trade.settlement = outcome;
    const won = trade.side === outcome;
    trade.gross_pnl = won ? trade.contracts - trade.entry_cost : -trade.entry_cost;
    trade.net_pnl = trade.gross_pnl - trade.fees;
    stats.resolvedTrades++;
    if (won) {
      stats.wins++;
      cashBalance += trade.contracts;
    } else stats.losses++;
    stats.grossPnl += trade.gross_pnl;
    stats.netPnl += trade.net_pnl;
  };
  const processQuote = quote => {
    stats.kalshiQuotes++;
    const now = quote.received_at_ms;
    const market = markets.get(quote.ticker);
    if (!market) { stats.missingMarketMetadata++; return; }
    const { open, close } = market.times;
    if (!Number.isFinite(open) || !Number.isFinite(close)) return;
    if (held.has(quote.ticker)) return;
    if (!market.reference || !Number.isFinite(market.reference.price) ||
        Math.abs(market.reference.timestamp - open) > 2500 || market.reference.timestamp > now) {
      stats.missingOpenReference++;
      return;
    }
    const sinceOpen = now - open;
    const remaining = close - now;
    if (sinceOpen < 0 || sinceOpen > config.windowMs || remaining < config.minTimeToCloseMs) return;
    if (!(latestBinanceMid > 0)) return;

    const probabilities = impliedProbabilities(latestBinanceMid, market.reference.price, now, open, close, binanceSamples);
    if (!probabilities) return;
    const quotes = quote.quotes || {};
    const candidates = [
      { side: 'yes', probability: probabilities.yes, ask: quotes.yesAsk, levels: quotes.depth?.yesAsks },
      { side: 'no', probability: probabilities.no, ask: quotes.noAsk, levels: quotes.depth?.noAsks },
    ];
    for (const candidate of candidates) {
      const price = candidate.ask?.price;
      if (!Number.isFinite(price) || price < config.minPrice || price > config.maxPrice) continue;
      const expectedEntry = price + config.slippagePerContract;
      if (expectedEntry >= 1) continue;
      const fee = estimateTakerFeeDollars(expectedEntry, 1, config.feeRate);
      const edge = expectedValuePerContract(candidate.probability, expectedEntry, fee);
      if (edge <= config.minEdge) continue;
      stats.candidateSignals++;
      const fill = fillAtAsk(candidate.levels, config.contracts);
      if (!fill) { stats.insufficientAskDepth++; continue; }
      const simulatedPrice = fill.averagePrice + config.slippagePerContract;
      if (simulatedPrice >= 1) continue;
      const simulatedNotional = simulatedPrice * fill.contracts;
      const fees = estimateTakerFeeDollars(simulatedPrice, fill.contracts, config.feeRate);
      if (simulatedNotional + fees > cashBalance) continue;
      const trade = {
        type: 'paper_trade', ticker: quote.ticker, side: candidate.side,
        decision_received_at_ms: now, source_ts_ms: quote.source_ts_ms,
        entry_price: simulatedPrice, observed_ask_average: fill.averagePrice, contracts: fill.contracts,
        model_probability: candidate.probability, estimated_edge_per_contract: edge,
        entry_cost: simulatedNotional, fees, settlement: null, gross_pnl: null, net_pnl: null,
      };
      writeTrade(trade);
      stats.filledTrades++;
      stats.fees += fees;
      held.add(quote.ticker);
      cashBalance -= simulatedNotional + fees;
      allTrades.push(trade);
      pendingTrades.set(quote.ticker, trade);
      break;
    }
  };

  const source = fs.createReadStream(resolvedInput, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: source, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      stats.captureRecords++;
      let record;
      try { record = JSON.parse(line); }
      catch { stats.captureMalformed++; replay.recordMalformed(lineNumber, path.basename(resolvedInput), new Error('Malformed JSON')); continue; }

      if (record.type === 'market_metadata') {
        const payload = record.payload || {};
        const ticker = payload.market_ticker || payload.ticker;
        if (ticker) {
          const reference = payload.reference_at_open;
          const refTime = timeMs(reference?.source_ts_ms ?? reference?.timestamp);
          markets.set(ticker, {
            times: marketTimes(payload),
            reference: reference && Number.isFinite(Number(reference.price)) && refTime !== null
              ? { price: Number(reference.price), timestamp: refTime } : null,
          });
        }
      } else if (record.type === 'market_settlement') {
        const payload = record.payload || {};
        const ticker = payload.ticker || payload.market_ticker;
        if (ticker && (payload.result === 'yes' || payload.result === 'no')) {
          const trade = pendingTrades.get(ticker);
          if (trade) {
            settleTrade(trade, payload.result);
            pendingTrades.delete(ticker);
          }
        }
      } else if (record.type === 'binance_book_ticker') {
        const bid = Number(record.payload?.bid), ask = Number(record.payload?.ask);
        const timestamp = Number(record.received_at_ms);
        if (bid > 0 && ask >= bid && Number.isFinite(timestamp)) {
          latestBinanceMid = (bid + ask) / 2;
          if (timestamp - lastBinanceSampleAt >= 1000) {
            binanceSamples.push({ price: latestBinanceMid, timestamp });
            lastBinanceSampleAt = timestamp;
            if (binanceSamples.length > 3600) binanceSamples.shift();
            stats.binanceSamples++;
          }
        }
      }

      for (const output of replay.consume(record)) {
        if (output.type === 'replay_quote') processQuote(output);
      }
    }
    await finished(source);
  } finally {
    tradesStream.end();
    await finished(tradesStream);
  }

  const tradeRows = allTrades;
  stats.missingSettlement = pendingTrades.size;
  // Rewrite trade output with settlement labels after using full-file outcomes.
  await fs.promises.writeFile(resolvedTrades, tradeRows.map(row => JSON.stringify(row)).join('\n') + (tradeRows.length ? '\n' : ''));
  stats.endingBalance = cashBalance;
  const resolvedEntryCost = tradeRows.filter(row => row.settlement).reduce((sum, row) => sum + row.entry_cost, 0);
  const summary = {
    schema_version: 1,
    type: 'kalshi_capture_paper_simulation_summary',
    input_file: path.basename(resolvedInput),
    methodology: {
      execution: 'Buy at contemporaneous reconstructed asks, require displayed ask depth, apply configured adverse slippage; one entry per market; hold to settlement. No queue or latency model.',
      fees: `Estimated taker fee rate ${config.feeRate}; adverse slippage ${config.slippagePerContract} per contract.`,
      data: 'Capture order and received timestamps; valid order-book snapshots and contiguous deltas only; Binance midpoint sampled at most once per second.',
      restrictions: 'No live orders, no Polymarket strategy (its prices are not in this capture), and no claim of predictive profitability from this sample.',
    },
    parameters: config,
    stats,
    replay: replay.summary().stats,
    validBooksAtEnd: replay.summary().valid_books_at_end.length,
    settled_win_rate: stats.resolvedTrades ? stats.wins / stats.resolvedTrades : null,
    roi_on_resolved_entry_cost: resolvedEntryCost > 0 ? stats.netPnl / resolvedEntryCost : null,
    unresolved_trade_count: stats.missingSettlement,
    outputs: { trades: path.basename(resolvedTrades), summary: path.basename(resolvedSummary) },
  };
  await fs.promises.writeFile(resolvedSummary, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); console.error(usage()); process.exitCode = 2; return; }
  if (args.help) { console.log(usage()); return; }
  try {
    const summary = await simulate(args);
    console.log(JSON.stringify({
      candidate_signals: summary.stats.candidateSignals,
      filled_trades: summary.stats.filledTrades,
      resolved_trades: summary.stats.resolvedTrades,
      wins: summary.stats.wins,
      losses: summary.stats.losses,
      net_pnl: Number(summary.stats.netPnl.toFixed(4)),
      win_rate: summary.settled_win_rate,
      sequence_gaps: summary.replay.sequenceGaps,
      valid_books_at_end: summary.validBooksAtEnd,
      trades_file: summary.outputs.trades,
      summary_file: path.resolve(args.summaryPath || `${args.input.replace(/\.jsonl$/i, '')}.paper-summary.json`),
    }, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { DEFAULTS, parseArgs, simulate, impliedProbabilities, fillAtAsk };
