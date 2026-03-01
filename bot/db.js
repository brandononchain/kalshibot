/**
 * SQLite Analytics Ledger
 *
 * Append-only structured logging for signals, orders, fills, and market
 * snapshots. Designed for post-hoc analysis and strategy optimisation —
 * state.json remains the fast UI/persistence path.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'analytics.db');

class AnalyticsDB {
  constructor() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._createTables();
    this._prepareStatements();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        type          TEXT NOT NULL,
        ticker        TEXT NOT NULL,
        side          TEXT NOT NULL,
        price_cents   INTEGER,
        edge          REAL,
        model_prob    REAL,
        contracts     INTEGER,
        execution_mode TEXT,
        reason        TEXT,
        executed      INTEGER DEFAULT 0,
        blocked_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        order_id        TEXT UNIQUE NOT NULL,
        client_order_id TEXT,
        signal_id       INTEGER REFERENCES signals(id),
        ticker          TEXT NOT NULL,
        side            TEXT NOT NULL,
        action          TEXT NOT NULL,
        price_cents     INTEGER,
        count           INTEGER,
        status          TEXT,
        fill_count      INTEGER DEFAULT 0,
        taker_fill_cost INTEGER DEFAULT 0,
        taker_fees      INTEGER DEFAULT 0,
        close_time      INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fills (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        order_id    TEXT NOT NULL,
        ticker      TEXT NOT NULL,
        side        TEXT NOT NULL,
        fill_count  INTEGER,
        prev_fills  INTEGER,
        new_fills   INTEGER,
        source      TEXT
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        ticker        TEXT NOT NULL,
        yes_bid       INTEGER,
        yes_ask       INTEGER,
        no_bid        INTEGER,
        no_ask        INTEGER,
        btc_price     REAL,
        time_remaining_s INTEGER,
        context       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker);
      CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_fills_order_id ON fills(order_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON market_snapshots(ticker);
    `);
  }

  _prepareStatements() {
    this._insertSignal = this.db.prepare(`
      INSERT INTO signals (ts, type, ticker, side, price_cents, edge, model_prob,
                           contracts, execution_mode, reason, executed, blocked_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertOrder = this.db.prepare(`
      INSERT INTO orders (ts, order_id, client_order_id, signal_id, ticker, side,
                          action, price_cents, count, status, fill_count,
                          taker_fill_cost, taker_fees, close_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._updateOrder = this.db.prepare(`
      UPDATE orders SET status = ?, fill_count = ?, taker_fill_cost = ?,
                        taker_fees = ?, updated_at = ?
      WHERE order_id = ?
    `);

    this._insertFill = this.db.prepare(`
      INSERT INTO fills (ts, order_id, ticker, side, fill_count, prev_fills, new_fills, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertSnapshot = this.db.prepare(`
      INSERT INTO market_snapshots (ts, ticker, yes_bid, yes_ask, no_bid, no_ask,
                                    btc_price, time_remaining_s, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Log a signal (generated or blocked).
   * Returns the signal row id for linking to orders.
   */
  logSignal(signal, executed = false, blockedReason = null) {
    try {
      const result = this._insertSignal.run(
        Date.now(),
        signal.type,
        signal.ticker,
        signal.side,
        signal.priceCents,
        signal.edge,
        signal.modelProb,
        signal.contracts,
        signal.executionMode || 'taker',
        signal.reason,
        executed ? 1 : 0,
        blockedReason
      );
      return result.lastInsertRowid;
    } catch (err) {
      console.error('[DB] logSignal error:', err.message);
      return null;
    }
  }

  /**
   * Log a placed order.
   */
  logOrder(order, signalId = null) {
    try {
      const now = Date.now();
      this._insertOrder.run(
        now,
        order.order_id,
        order.client_order_id || null,
        signalId,
        order.ticker,
        order.side,
        order.action || 'buy',
        order.price_cents || 0,
        order.count || 0,
        order.status || 'pending',
        order.fill_count || 0,
        order.taker_fill_cost || 0,
        order.taker_fees || 0,
        order.close_time || null,
        now,
        now
      );
    } catch (err) {
      console.error('[DB] logOrder error:', err.message);
    }
  }

  /**
   * Update an existing order's status/fills.
   */
  updateOrder(orderId, status, fillCount, takerFillCost = 0, takerFees = 0) {
    try {
      this._updateOrder.run(status, fillCount, takerFillCost, takerFees, Date.now(), orderId);
    } catch (err) {
      console.error('[DB] updateOrder error:', err.message);
    }
  }

  /**
   * Log a fill event (new fills detected on poll).
   */
  logFill(orderId, ticker, side, fillCount, prevFills, source = 'poll') {
    try {
      this._insertFill.run(
        Date.now(),
        orderId,
        ticker,
        side,
        fillCount,
        prevFills,
        fillCount - prevFills,
        source
      );
    } catch (err) {
      console.error('[DB] logFill error:', err.message);
    }
  }

  /**
   * Snapshot the market state around an execution event.
   */
  logMarketSnapshot(market, btcPrice, context = 'execution') {
    try {
      const now = Date.now();
      const timeRemaining = market.closeTime ? Math.floor((market.closeTime - now) / 1000) : null;
      this._insertSnapshot.run(
        now,
        market.ticker,
        market.yesBidCents || Math.round((market.yesBid || 0) * 100),
        market.yesAskCents || Math.round((market.yesAsk || 0) * 100),
        market.noBidCents || Math.round((market.noBid || 0) * 100),
        market.noAskCents || Math.round((market.noAsk || 0) * 100),
        btcPrice || null,
        timeRemaining,
        context
      );
    } catch (err) {
      console.error('[DB] logMarketSnapshot error:', err.message);
    }
  }

  close() {
    try {
      this.db.close();
    } catch (err) {
      // ignore
    }
  }
}

module.exports = AnalyticsDB;
