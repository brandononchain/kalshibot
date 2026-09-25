'use strict';

const {
  normalizeSnapshot,
  applyDelta,
  executableQuotes,
  hasSequenceGap,
} = require('./kalshi-orderbook');

function finiteInteger(value) {
  return Number.isInteger(value) && Number.isSafeInteger(value);
}

function sourceTimestamp(record, message) {
  if (Number.isFinite(record?.source_ts_ms)) return record.source_ts_ms;
  const ts = Number(message?.msg?.ts_ms);
  if (Number.isFinite(ts) && ts > 0) return ts;
  const created = message?.msg?.created_time;
  if (created) {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

class KalshiCaptureReplay {
  constructor() {
    this.books = new Map();
    this.lastSequenceBySid = new Map();
    this.channelBySid = new Map();
    this.stats = {
      records: 0,
      malformedRecords: 0,
      rawKalshiMessages: 0,
      snapshots: 0,
      acceptedDeltas: 0,
      skippedDeltas: 0,
      sequenceGaps: 0,
      captureGapEvents: 0,
      bookApplyErrors: 0,
      disconnects: 0,
      typeCounts: {},
      markets: {},
    };
  }

  _marketStats(ticker) {
    if (!this.stats.markets[ticker]) {
      this.stats.markets[ticker] = {
        snapshots: 0,
        accepted_deltas: 0,
        skipped_deltas: 0,
        sequence_gaps: 0,
        recoveries: 0,
        last_valid_received_at_ms: null,
      };
    }
    return this.stats.markets[ticker];
  }

  _diagnostic(kind, message, details = {}) {
    return { schema_version: 1, type: 'replay_diagnostic', kind, message, ...details };
  }

  _invalidateBook(ticker) {
    const state = this.books.get(ticker);
    if (state) state.valid = false;
  }

  _invalidateSid(sid) {
    const invalidated = [];
    for (const state of this.books.values()) {
      if (state.sid === sid) {
        state.valid = false;
        invalidated.push(state.book.ticker);
      }
    }
    return invalidated;
  }

  _invalidateAll() {
    for (const state of this.books.values()) state.valid = false;
    this.lastSequenceBySid.clear();
    this.channelBySid.clear();
  }

  _quoteRecord(record, message, ticker, state) {
    return {
      schema_version: 1,
      type: 'replay_quote',
      ticker,
      sid: state.sid,
      seq: state.book.seq,
      source_ts_ms: sourceTimestamp(record, message),
      received_at_ms: Number.isFinite(record?.received_at_ms) ? record.received_at_ms : null,
      quotes: executableQuotes(state.book),
    };
  }

  _handleSnapshot(record, message, output) {
    this.stats.snapshots += 1;
    const normalized = normalizeSnapshot(message);
    const ticker = normalized.ticker;
    const sid = message.sid;
    const seq = message.seq;
    if (!ticker || !finiteInteger(sid) || !finiteInteger(seq)) {
      this.stats.sequenceGaps += 1;
      if (finiteInteger(sid)) {
        const invalidated = this._invalidateSid(sid);
        for (const affectedTicker of invalidated) {
          this._marketStats(affectedTicker).sequence_gaps += 1;
        }
        this.lastSequenceBySid.delete(sid);
      } else if (ticker) this._invalidateBook(ticker);
      else this._invalidateAll();
      output.push(this._diagnostic('invalid_snapshot', 'Snapshot is missing ticker, SID, or a safe integer sequence.', {
        ticker: ticker || null, sid: sid ?? null, seq: seq ?? null,
      }));
      return;
    }

    const previousSeq = this.lastSequenceBySid.get(sid);
    if (previousSeq !== undefined && seq < previousSeq) {
      this._invalidateBook(ticker);
      output.push(this._diagnostic('stale_snapshot', 'Older snapshot rejected; it cannot restore a book after newer stream data.', {
        ticker, sid, previous_seq: previousSeq, snapshot_seq: seq,
      }));
      return;
    }

    const snapshotGap = previousSeq !== undefined && hasSequenceGap(previousSeq, seq);
    let invalidated = [];
    if (snapshotGap) {
      invalidated = this._invalidateSid(sid);
      this.stats.sequenceGaps += 1;
      for (const affectedTicker of invalidated) {
        this._marketStats(affectedTicker).sequence_gaps += 1;
      }
    }

    const prior = this.books.get(ticker);
    const marketStats = this._marketStats(ticker);
    if (prior && !prior.valid) marketStats.recoveries += 1;
    normalized.sid = sid;
    normalized.seq = seq;
    const state = { book: normalized, sid, valid: true };
    this.books.set(ticker, state);
    this.lastSequenceBySid.set(sid, Math.max(previousSeq ?? seq, seq));
    marketStats.snapshots += 1;
    marketStats.last_valid_received_at_ms = Number.isFinite(record?.received_at_ms) ? record.received_at_ms : null;
    output.push(this._quoteRecord(record, message, ticker, state));
    if (snapshotGap) {
      output.push(this._diagnostic('snapshot_sequence_gap', 'Snapshot restored this market, but other books on the same stream were invalidated because sequence numbers were skipped.', {
        ticker, sid, previous_seq: previousSeq, snapshot_seq: seq,
        invalidated_tickers: invalidated.filter(value => value !== ticker),
      }));
    }
  }

  _handleDelta(record, message, output) {
    const delta = message.msg || {};
    const ticker = delta.market_ticker || delta.ticker || null;
    const sid = message.sid;
    const seq = message.seq;
    const marketStats = ticker ? this._marketStats(ticker) : null;
    if (!ticker || !finiteInteger(sid) || !finiteInteger(seq)) {
      if (finiteInteger(sid)) {
        for (const affectedTicker of this._invalidateSid(sid)) {
          this._marketStats(affectedTicker).sequence_gaps += 1;
        }
        this.lastSequenceBySid.delete(sid);
      } else if (ticker) this._invalidateBook(ticker);
      else this._invalidateAll();
      this.stats.skippedDeltas += 1;
      if (marketStats) marketStats.skipped_deltas += 1;
      output.push(this._diagnostic('invalid_delta_envelope', 'Delta is missing ticker, SID, or a safe integer sequence.', {
        ticker, sid: sid ?? null, seq: seq ?? null,
      }));
      return;
    }

    const previousSeq = this.lastSequenceBySid.get(sid);
    if (previousSeq === undefined || hasSequenceGap(previousSeq, seq)) {
      this.stats.sequenceGaps += 1;
      const invalidated = this._invalidateSid(sid);
      for (const affectedTicker of invalidated) {
        this._marketStats(affectedTicker).sequence_gaps += 1;
      }
      if (previousSeq === undefined) this._invalidateBook(ticker);
      else this.lastSequenceBySid.set(sid, Math.max(previousSeq, seq));
      this.stats.skippedDeltas += 1;
      if (marketStats) marketStats.skipped_deltas += 1;
      output.push(this._diagnostic(previousSeq === undefined ? 'sequence_baseline_missing' : 'sequence_gap',
        previousSeq === undefined
          ? 'Delta skipped because no snapshot established a sequence baseline.'
          : 'Delta skipped and every book on this orderbook stream invalidated because the sequence is not contiguous.', {
          ticker, sid, previous_seq: previousSeq ?? null, current_seq: seq,
        }));
      return;
    }

    this.lastSequenceBySid.set(sid, seq);
    const state = this.books.get(ticker);
    if (!state || !state.valid || state.sid !== sid) {
      this.stats.skippedDeltas += 1;
      marketStats.skipped_deltas += 1;
      output.push(this._diagnostic('delta_without_valid_snapshot', 'Delta skipped until a fresh snapshot restores this market book.', {
        ticker, sid, seq,
      }));
      return;
    }

    try {
      applyDelta(state.book, message);
    } catch (error) {
      state.valid = false;
      this.stats.bookApplyErrors += 1;
      this.stats.skippedDeltas += 1;
      marketStats.skipped_deltas += 1;
      output.push(this._diagnostic('book_apply_error', error.message, { ticker, sid, seq }));
      return;
    }

    this.stats.acceptedDeltas += 1;
    marketStats.accepted_deltas += 1;
    marketStats.last_valid_received_at_ms = Number.isFinite(record?.received_at_ms) ? record.received_at_ms : null;
    output.push(this._quoteRecord(record, message, ticker, state));
  }

  consume(record) {
    this.stats.records += 1;
    const type = record && typeof record.type === 'string' ? record.type : 'unknown';
    this.stats.typeCounts[type] = (this.stats.typeCounts[type] || 0) + 1;
    const output = [];

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      this.stats.malformedRecords += 1;
      output.push(this._diagnostic('invalid_record', 'Capture row must be a JSON object.'));
      return output;
    }

    if (type === 'connection' && record.payload?.service === 'kalshi') {
      if (record.payload.status === 'disconnected' || record.payload.status === 'connected') {
        this._invalidateAll();
        if (record.payload.status === 'disconnected') this.stats.disconnects += 1;
      }
      return output;
    }

    if (type === 'sequence_gap') {
      this.stats.captureGapEvents += 1;
      const sid = record.payload?.sid;
      if (finiteInteger(sid)) this._invalidateSid(sid);
      else if (record.payload?.ticker) this._invalidateBook(record.payload.ticker);
      output.push(this._diagnostic('captured_sequence_gap', 'Collector recorded a sequence gap; affected books remain invalid until resnapshotted.', {
        ticker: record.payload?.ticker || null, sid: sid ?? null,
        previous_seq: record.payload?.previous_seq ?? null,
        current_seq: record.payload?.current_seq ?? null,
      }));
      return output;
    }

    if (type !== 'kalshi_ws') return output;
    this.stats.rawKalshiMessages += 1;
    const message = record.payload;
    if (!message || typeof message !== 'object') {
      output.push(this._diagnostic('invalid_kalshi_message', 'Raw Kalshi message payload is missing.'));
      return output;
    }

    if (message.type === 'subscribed' && finiteInteger(message.msg?.sid)) {
      this.channelBySid.set(message.msg.sid, message.msg.channel || 'unknown');
      return output;
    }
    if (message.type === 'orderbook_snapshot') {
      this._handleSnapshot(record, message, output);
      return output;
    }
    if (message.type === 'orderbook_delta') {
      this._handleDelta(record, message, output);
      return output;
    }

    // Trade and other channels keep their own sequence cursor. A trade-channel
    // gap is reported but does not invalidate an otherwise contiguous book.
    if (finiteInteger(message.sid) && finiteInteger(message.seq)) {
      const previousSeq = this.lastSequenceBySid.get(message.sid);
      if (previousSeq !== undefined && hasSequenceGap(previousSeq, message.seq)) {
        const channel = this.channelBySid.get(message.sid);
        if (channel === 'orderbook_delta') this._invalidateSid(message.sid);
        this.stats.sequenceGaps += 1;
        output.push(this._diagnostic('channel_sequence_gap', `Sequence gap on ${channel || 'unknown'} channel.`, {
          sid: message.sid, channel: channel || null, previous_seq: previousSeq, current_seq: message.seq,
        }));
      }
      this.lastSequenceBySid.set(message.sid, message.seq);
    }
    return output;
  }

  recordMalformed(lineNumber, file, error) {
    this.stats.records += 1;
    this.stats.malformedRecords += 1;
    this.stats.typeCounts.malformed = (this.stats.typeCounts.malformed || 0) + 1;
    this._invalidateAll();
    return this._diagnostic('malformed_json', error.message, { file, line: lineNumber });
  }

  summary(extra = {}) {
    const validBooks = [...this.books.entries()].filter(([, state]) => state.valid);
    return {
      schema_version: 1,
      type: 'kalshi_capture_replay_summary',
      generated_at: new Date().toISOString(),
      ...extra,
      stats: { ...this.stats },
      valid_books_at_end: validBooks.map(([ticker, state]) => ({ ticker, sid: state.sid, seq: state.book.seq })),
      invalid_books_at_end: [...this.books.entries()]
        .filter(([, state]) => !state.valid)
        .map(([ticker, state]) => ({ ticker, sid: state.sid, seq: state.book.seq })),
    };
  }
}

module.exports = { KalshiCaptureReplay };
