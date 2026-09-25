#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
const { finished } = require('stream/promises');
const { KalshiCaptureReplay } = require('../lib/kalshi-capture-replay');

function usage() {
  return `Replay captured Kalshi JSONL without connecting to an exchange or placing orders.

Usage:
  node scripts/replay-kalshi-capture.js <capture.jsonl> [more-captures.jsonl ...]
    [--quotes <replay-quotes.jsonl>] [--summary <replay-summary.json>]

Input files are processed in the order supplied. For rotated captures, pass files
from oldest to newest. By default, outputs are written beside the first input.
`;
}

function parseArgs(argv) {
  const inputs = [];
  let quotesPath = null;
  let summaryPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--quotes' || arg === '--summary') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a file path`);
      if (arg === '--quotes') quotesPath = value;
      else summaryPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    inputs.push(arg);
  }
  if (!inputs.length) throw new Error('Provide at least one capture JSONL file');
  const first = path.resolve(inputs[0]);
  const stem = first.replace(/\.jsonl$/i, '');
  return {
    help: false,
    inputs: inputs.map(file => path.resolve(file)),
    quotesPath: path.resolve(quotesPath || `${stem}.replay-quotes.jsonl`),
    summaryPath: path.resolve(summaryPath || `${stem}.replay-summary.json`),
  };
}

function assertDistinctOutputs(options) {
  const inputSet = new Set(options.inputs);
  if (inputSet.has(options.quotesPath) || inputSet.has(options.summaryPath)) {
    throw new Error('Replay outputs must not overwrite any input capture');
  }
  if (options.quotesPath === options.summaryPath) throw new Error('Quote and summary outputs must use different paths');
}

async function writeJsonLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain');
}

async function replay(options) {
  assertDistinctOutputs(options);
  for (const input of options.inputs) {
    const stat = await fs.promises.stat(input);
    if (!stat.isFile()) throw new Error(`Input is not a file: ${input}`);
  }
  await fs.promises.mkdir(path.dirname(options.quotesPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(options.summaryPath), { recursive: true });

  const engine = new KalshiCaptureReplay();
  const quotes = fs.createWriteStream(options.quotesPath, { flags: 'w' });
  let lineCount = 0;
  try {
    for (const input of options.inputs) {
      const source = fs.createReadStream(input, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: source, crlfDelay: Infinity });
      lineCount = 0;
      for await (const line of lines) {
        lineCount += 1;
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          await writeJsonLine(quotes, engine.recordMalformed(lineCount, path.basename(input), error));
          continue;
        }
        for (const output of engine.consume(record)) await writeJsonLine(quotes, output);
      }
      await finished(source);
    }
  } finally {
    quotes.end();
    await finished(quotes);
  }

  const summary = engine.summary({
    input_files: options.inputs.map(file => ({
      name: path.basename(file),
      bytes: fs.statSync(file).size,
    })),
    quotes_file: path.basename(options.quotesPath),
    ordering: 'input file order, then JSONL line order',
    interpretation: 'Quotes are emitted only from valid snapshots and contiguous orderbook deltas. No fills, fees, PnL, or profitability are simulated.',
  });
  await fs.promises.writeFile(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'w' });
  return summary;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const summary = await replay(options);
    console.log(JSON.stringify({
      records: summary.stats.records,
      snapshots: summary.stats.snapshots,
      accepted_deltas: summary.stats.acceptedDeltas,
      skipped_deltas: summary.stats.skippedDeltas,
      sequence_gaps: summary.stats.sequenceGaps,
      malformed_records: summary.stats.malformedRecords,
      valid_books_at_end: summary.valid_books_at_end.length,
      quotes_file: options.quotesPath,
      summary_file: options.summaryPath,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, replay };
