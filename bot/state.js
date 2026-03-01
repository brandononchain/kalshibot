const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const PERSIST_DIR = path.join(__dirname, '..', 'data');
const PERSIST_PATH = path.join(PERSIST_DIR, 'state.json');
const SAVE_DEBOUNCE_MS = 5000;
const MAX_PNL_HISTORY = 500;
const MAX_TRADE_LOG = 500;
const MAX_CLOSED_POSITIONS = 100;

class BotState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // Connection status
    this.connections = {
      binance: false,
      polymarket: false,
      kalshi: false,
      redstone: false,
    };

    // Live BTC price from multiple sources
    this.btcPrice = {
      binance: null,
      binanceBid: null,
      binanceAsk: null,
      redstone: null,
      lastUpdate: null,
    };

    // Market open reference price (for calculating move %)
    this.marketOpenPrices = {};
    this.marketOpenPriceStale = {}; // Flags for open prices set late (discovered after open)

    // Kalshi account
    this.balance = { total: 0, available: 0, reserved: 0 };
    this.startingBalance = 0; // Set once on first balance fetch, used for drawdown calc

    // Active Kalshi markets
    this.activeMarkets = [];

    // Polymarket prices cache
    this.polymarketCache = {};

    // Positions
    this.pendingOrders = [];   // Orders placed but not yet confirmed filled
    this.openPositions = [];   // Confirmed filled positions
    this.closedPositions = [];

    // Trade log (all actions)
    this.tradeLog = [];

    // P&L history for charting
    this.pnlHistory = [];

    // Bot intent (what it's thinking/doing)
    this.intent = {
      status: 'initializing',
      message: 'Starting up...',
      lastSignal: null,
      modelProbability: null,
      currentEdge: null,
      action: null,
    };

    // Stats
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      volumeTraded: 0,
      startTime: Date.now(),
      tradesPerHour: 0,
      bestTrade: 0,
      worstTrade: 0,
      avgEdge: 0,
      totalEdge: 0,
      grossWins: 0,
      grossLosses: 0,
      streak: 0,
      strategyStats: {},
      unrealizedPnL: 0,
    };

    // Strategy model state
    this.model = {
      impliedProbUp: null,
      impliedProbDown: null,
      spotMove: null,
      spotMovePct: null,
      timeRemaining: null,
      volatility: 0.0015,
      // 1H trend indicator
      trend: 'NEUTRAL',
      trendStrength: 0,
      trendROC: 0,
      trendWarmup: false,
    };

    // Persistence
    this._saveTimer = null;
    this._loadState();
  }

  // ===== Persistence =====

  _loadState() {
    try {
      if (!fs.existsSync(PERSIST_PATH)) {
        console.log('[State] No persisted state found, starting fresh');
        return;
      }
      const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
      const saved = JSON.parse(raw);

      if (saved.stats) {
        this.stats = { ...this.stats, ...saved.stats };
        // Ensure strategyStats is always an object (old state may not have it)
        if (!this.stats.strategyStats || typeof this.stats.strategyStats !== 'object') {
          this.stats.strategyStats = {};
        }
      }
      if (Array.isArray(saved.closedPositions)) {
        this.closedPositions = saved.closedPositions.slice(-MAX_CLOSED_POSITIONS);
      }
      if (Array.isArray(saved.tradeLog)) {
        this.tradeLog = saved.tradeLog.slice(0, MAX_TRADE_LOG);
      }
      if (Array.isArray(saved.pnlHistory)) {
        this.pnlHistory = saved.pnlHistory.slice(-MAX_PNL_HISTORY);
      }
      if (Array.isArray(saved.pendingOrders)) {
        this.pendingOrders = saved.pendingOrders;
      }
      if (Array.isArray(saved.openPositions)) {
        this.openPositions = saved.openPositions;
      }

      console.log(`[State] Loaded: ${this.stats.totalTrades} trades, P&L: $${this.stats.totalPnL.toFixed(2)}, ${this.pendingOrders.length} pending, ${this.openPositions.length} open positions, uptime since ${new Date(this.stats.startTime).toISOString()}`);
    } catch (err) {
      console.error('[State] Failed to load persisted state:', err.message);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  _writeToDisk() {
    try {
      if (!fs.existsSync(PERSIST_DIR)) {
        fs.mkdirSync(PERSIST_DIR, { recursive: true });
      }

      const data = {
        _savedAt: new Date().toISOString(),
        stats: { ...this.stats },
        pendingOrders: this.pendingOrders,
        openPositions: this.openPositions,
        closedPositions: this.closedPositions.slice(-MAX_CLOSED_POSITIONS),
        tradeLog: this.tradeLog
          .filter(t => t.type === 'TRADE' || t.type === 'SETTLEMENT')
          .slice(0, MAX_TRADE_LOG),
        pnlHistory: this.pnlHistory.slice(-MAX_PNL_HISTORY),
      };

      const tmpPath = PERSIST_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, PERSIST_PATH);
    } catch (err) {
      console.error('[State] Failed to save state:', err.message);
    }
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeToDisk();
  }

  // ===== Price Updates =====

  updateBinancePrice(bid, ask) {
    const mid = (bid + ask) / 2;
    this.btcPrice.binance = mid;
    this.btcPrice.binanceBid = bid;
    this.btcPrice.binanceAsk = ask;
    this.btcPrice.lastUpdate = Date.now();
    this.connections.binance = true;
    this.emit('price:binance', { bid, ask, mid });
  }

  updateRedstonePrice(price, timestamp) {
    this.btcPrice.redstone = price;
    this.connections.redstone = true;
    this.emit('price:redstone', { price, timestamp });
  }

  // ===== Connection & Market Updates =====

  updateConnection(name, connected) {
    if (this.connections[name] === connected) return; // No change, skip emit
    this.connections[name] = connected;
    this.emit(`connection:${name}`, connected);
  }

  updateKalshiConnection(connected) {
    this.updateConnection('kalshi', connected);
  }

  updateBalance(balance) {
    this.balance = balance;
    // Set starting balance once (first balance fetch after startup)
    if (this.startingBalance === 0 && balance.total > 0) {
      this.startingBalance = balance.total;
    }
    this.emit('balance', balance);
  }

  updateMarkets(markets) {
    this.activeMarkets = markets;
    this.emit('markets', markets);
  }

  updateIntent(intent) {
    this.intent = { ...this.intent, ...intent };
    this.emit('intent', this.intent);
  }

  updateModel(model) {
    this.model = { ...this.model, ...model };
    this.emit('model', this.model);
  }

  // ===== Trade & Position Tracking =====

  logTrade(trade) {
    this.tradeLog.unshift({
      ...trade,
      timestamp: Date.now(),
    });
    if (this.tradeLog.length > MAX_TRADE_LOG) this.tradeLog.pop();
    this.emit('trade', trade);

    // Persist on meaningful trades only
    if (trade.type === 'TRADE' || trade.type === 'SETTLEMENT') {
      this._scheduleSave();
    }
  }

  addPendingOrder(order) {
    this.pendingOrders.push(order);
    this.emit('order:pending', order);
    this._scheduleSave();
  }

  removePendingOrder(orderId) {
    const idx = this.pendingOrders.findIndex(o => o.orderId === orderId);
    if (idx === -1) return;
    const removed = this.pendingOrders.splice(idx, 1)[0];
    this.emit('order:removed', removed);
    this._scheduleSave();
  }

  addPosition(position) {
    this.openPositions.push(position);
    this.emit('position:open', position);
    this._scheduleSave(); // Persist immediately so positions survive restarts
  }

  closePosition(orderId, result) {
    const idx = this.openPositions.findIndex(p => p.orderId === orderId);
    if (idx === -1) return;

    const position = this.openPositions.splice(idx, 1)[0];
    const closed = { ...position, ...result, settleTime: Date.now() };
    this.closedPositions.push(closed);

    // Cap closed positions
    if (this.closedPositions.length > MAX_CLOSED_POSITIONS) {
      this.closedPositions = this.closedPositions.slice(-MAX_CLOSED_POSITIONS);
    }

    // Update stats
    this.stats.totalTrades++;
    if (closed.won) this.stats.wins++;
    else this.stats.losses++;
    this.stats.totalPnL += closed.pnl;
    if (closed.pnl > this.stats.bestTrade) this.stats.bestTrade = closed.pnl;
    if (closed.pnl < this.stats.worstTrade) this.stats.worstTrade = closed.pnl;

    // Gross wins/losses
    if (closed.pnl > 0) this.stats.grossWins += closed.pnl;
    else this.stats.grossLosses += Math.abs(closed.pnl);

    // Streak
    if (closed.won) {
      this.stats.streak = this.stats.streak > 0 ? this.stats.streak + 1 : 1;
    } else {
      this.stats.streak = this.stats.streak < 0 ? this.stats.streak - 1 : -1;
    }

    // Per-strategy performance (DIRECTIONAL_YES → DIRECTIONAL)
    const stratKey = (closed.type || 'UNKNOWN').replace(/_YES$|_NO$/, '');
    if (!this.stats.strategyStats[stratKey]) {
      this.stats.strategyStats[stratKey] = { wins: 0, losses: 0 };
    }
    if (closed.won) this.stats.strategyStats[stratKey].wins++;
    else this.stats.strategyStats[stratKey].losses++;

    // Update P&L history
    this.pnlHistory.push({
      timestamp: Date.now(),
      pnl: closed.pnl,
      cumulative: this.stats.totalPnL,
    });

    // Cap P&L history
    if (this.pnlHistory.length > MAX_PNL_HISTORY) {
      this.pnlHistory = this.pnlHistory.slice(-MAX_PNL_HISTORY);
    }

    // Trades per hour
    const hours = (Date.now() - this.stats.startTime) / 3600000;
    this.stats.tradesPerHour = hours > 0 ? this.stats.totalTrades / hours : 0;

    this.emit('position:close', closed);
    this.emit('stats', this.stats);

    // Persist after position close
    this._scheduleSave();
  }

  // ===== Live Stats =====

  emitStats() {
    const hours = (Date.now() - this.stats.startTime) / 3600000;
    this.stats.tradesPerHour = hours > 0 ? this.stats.totalTrades / hours : 0;
    this.emit('stats', this.stats);
  }

  updateUnrealizedPnL(value) {
    this.stats.unrealizedPnL = value;
    this.emit('stats', this.stats);
  }

  // ===== Snapshot =====

  getSnapshot() {
    return {
      connections: this.connections,
      btcPrice: this.btcPrice,
      balance: this.balance,
      activeMarkets: this.activeMarkets,
      pendingOrders: this.pendingOrders,
      openPositions: this.openPositions,
      closedPositions: this.closedPositions.slice(-50),
      tradeLog: this.tradeLog.slice(0, 50),
      pnlHistory: this.pnlHistory,
      intent: this.intent,
      stats: this.stats,
      model: this.model,
      startTime: this.stats.startTime,
    };
  }
}

module.exports = BotState;
