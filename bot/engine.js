const BotState = require('./state');
const KalshiClient = require('./kalshi');
const BinanceFeed = require('./binance-ws');
const PolymarketFeed = require('./polymarket');
const RedstoneFeed = require('./redstone');
const Strategy = require('./strategy');
const TrendIndicator = require('./trend');
const OrderManager = require('./order-manager');
const AnalyticsDB = require('./db');

class BotEngine {
  constructor(config) {
    this.config = config;
    this.state = new BotState();

    this.kalshi = new KalshiClient(config, this.state);
    this.binance = new BinanceFeed(this.state, 'btcusdt');
    this.trend = new TrendIndicator(this.binance, config);
    this.binance.setTrendIndicator(this.trend);
    this.polymarket = new PolymarketFeed(this.state, config);
    this.redstone = new RedstoneFeed(this.state);
    this.strategy = new Strategy(this.state, config, this.binance, this.trend);
    this.db = new AnalyticsDB();
    this.orderManager = new OrderManager(this.kalshi, this.state, this.db, config);

    this.scanInterval = null;
    this.discoveryInterval = null;
    this.balanceInterval = null;
    this.takeProfitInterval = null;
    this.scanRunning = false;
    this.running = false;

    this.seriesTicker = config.SERIES_TICKER || 'KXBTC15M';
    this.slotDuration = config.SLOT_DURATION || 900; // 15 min in seconds
    this.maxOpenPositions = config.MAX_TOTAL_OPEN_POSITIONS || 10;
    this.maxPerContract = config.MAX_POSITIONS_PER_CONTRACT || 2;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;

    // Shared market cache — scan() writes, checkTakeProfit() reads
    this._marketCache = { data: [], ts: 0 };
    this._marketCacheTTL = 3000; // 3 seconds
  }

  async start() {
    this.running = true;
    this.log('Starting Kalshibot Engine');

    this.state.updateIntent({
      status: 'initializing',
      message: 'Connecting to data feeds...',
    });

    // Validate config
    if (!this.config.KALSHI_API_KEY) {
      throw new Error('KALSHI_API_KEY required in .env');
    }

    // Start data feeds
    this.binance.start();
    this.log('Binance WebSocket started');

    this.redstone.start();
    this.log('RedStone oracle started');

    // Test Kalshi connection
    this.state.updateIntent({ message: 'Connecting to Kalshi...' });
    try {
      const balance = await this.kalshi.fetchBalance();
      this.log(`Kalshi connected. Balance: $${balance.total.toFixed(2)}`);
    } catch (err) {
      this.log(`Kalshi connection failed: ${err.message}`, 'ERROR');
      throw err;
    }

    // Reconcile positions with Kalshi (prevents phantom position stacking)
    await this.reconcilePositions();

    // Start Polymarket polling
    this.polymarket.start();
    this.log('Polymarket feed started');

    // Initial market discovery
    await this.discoverMarkets();

    // Wait for Binance price before starting scans
    this.state.updateIntent({
      status: 'waiting',
      message: 'Waiting for Binance price feed...',
    });

    await new Promise((resolve) => {
      if (this.state.btcPrice.binance) return resolve();
      const check = setInterval(() => {
        if (this.state.btcPrice.binance) {
          clearInterval(check);
          resolve();
        }
      }, 500);
      // Timeout after 15 seconds
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });

    if (this.state.btcPrice.binance) {
      this.log(`BTC price: $${this.state.btcPrice.binance.toFixed(2)}`);
    }

    // Start order lifecycle manager
    this.orderManager.start();
    this.log('Order manager started');

    // Start periodic tasks
    this.discoveryInterval = setInterval(() => this.discoverMarkets(), 15000);
    this.balanceInterval = setInterval(() => this.refreshBalance(), 15000);
    this.scanInterval = setInterval(() => this.scan(), 2000);
    this.takeProfitInterval = setInterval(() => this.checkTakeProfit(), 3000);

    this.state.updateIntent({
      status: 'scanning',
      message: 'Scanning for opportunities...',
    });

    this.log('Engine running. All systems active.');
    return this.state;
  }

  log(msg, level = 'INFO') {
    const ts = new Date().toISOString();
    const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', ERROR: '\x1b[31m', WARN: '\x1b[33m' };
    console.log(`${colors[level] || ''}[${ts}] [${level}]\x1b[0m ${msg}`);

    this.state.logTrade({
      type: 'LOG',
      level,
      message: msg,
    });
  }

  async discoverMarkets() {
    try {
      const markets = await this.kalshi.discoverMarkets(this.seriesTicker);
      const now = Date.now();
      const processed = [];

      for (const m of markets) {
        const closeTime = new Date(m.close_time).getTime();
        const openTime = new Date(m.open_time).getTime();
        if (closeTime <= now) continue;

        const ticker = m.ticker;

        // Record the BTC price at market open as reference
        if (!this.state.marketOpenPrices[ticker] && this.state.btcPrice.binance) {
          this.state.marketOpenPrices[ticker] = this.state.btcPrice.binance;
        }

        processed.push({
          ticker,
          eventTicker: m.event_ticker,
          title: m.title,
          openTime,
          closeTime,
          yesBid: m.yes_bid / 100,
          yesAsk: m.yes_ask / 100,
          noBid: m.no_bid / 100,
          noAsk: m.no_ask / 100,
          yesBidCents: m.yes_bid,
          yesAskCents: m.yes_ask,
          noBidCents: m.no_bid,
          noAskCents: m.no_ask,
          lastPrice: m.last_price / 100,
          minutesUntilClose: Math.floor((closeTime - now) / 60000),
          secondsUntilClose: Math.floor((closeTime - now) / 1000),
          status: m.status,
        });
      }

      this.state.updateMarkets(processed);

      if (processed.length > 0) {
        this.log(`Tracking ${processed.length} markets (${this.seriesTicker})`);
      }

      // Clean up old open prices
      for (const ticker of Object.keys(this.state.marketOpenPrices)) {
        if (!processed.find(m => m.ticker === ticker)) {
          delete this.state.marketOpenPrices[ticker];
        }
      }
    } catch (err) {
      this.log(`Market discovery error: ${err.message}`, 'ERROR');
    }
  }

  async refreshBalance() {
    try {
      await this.kalshi.fetchBalance();
    } catch (err) {
      this.log(`Balance refresh error: ${err.message}`, 'WARN');
    }
  }

  async reconcilePositions() {
    this.state.updateIntent({ message: 'Reconciling positions with Kalshi...' });
    try {
      // Step 0: Prune locally-tracked positions with 0 fills (ghost orders that never executed)
      // With OrderManager, these should be rare, but clean up any legacy entries
      const beforePrune = this.state.openPositions.length;
      this.state.openPositions = this.state.openPositions.filter(p => {
        if ((p.filledContracts || 0) === 0 && p.type !== 'RECONCILED') {
          this.log(`Pruning unfilled ghost order: ${p.ticker} ${p.side} x${p.contracts}`, 'WARN');
          return false;
        }
        return true;
      });
      if (beforePrune !== this.state.openPositions.length) {
        this.log(`Pruned ${beforePrune - this.state.openPositions.length} unfilled ghost positions`);
      }

      // Also clear any stale pending orders from previous runs
      const stalePending = this.state.pendingOrders.length;
      if (stalePending > 0) {
        this.log(`Clearing ${stalePending} stale pending orders from previous session`, 'WARN');
        this.state.pendingOrders = [];
      }

      const kalshiPositions = await this.kalshi.fetchPositions(this.seriesTicker);
      const localPositions = this.state.openPositions;

      // Build map of Kalshi's actual positions by ticker+side
      const kalshiMap = new Map();
      for (const kp of kalshiPositions) {
        if (kp.yes_sub_total > 0) {
          kalshiMap.set(`${kp.ticker}:yes`, {
            ticker: kp.ticker,
            side: 'yes',
            contracts: kp.yes_sub_total,
          });
        }
        if (kp.no_sub_total > 0) {
          kalshiMap.set(`${kp.ticker}:no`, {
            ticker: kp.ticker,
            side: 'no',
            contracts: kp.no_sub_total,
          });
        }
      }

      // Build map of local positions by ticker+side (aggregate)
      const localMap = new Map();
      for (const lp of localPositions) {
        const key = `${lp.ticker}:${lp.side}`;
        const existing = localMap.get(key);
        if (existing) {
          existing.contracts += (lp.filledContracts || lp.contracts);
          existing.positions.push(lp);
        } else {
          localMap.set(key, {
            contracts: lp.filledContracts || lp.contracts,
            positions: [lp],
          });
        }
      }

      let added = 0;
      let removed = 0;

      // Positions on Kalshi but NOT in local state -> add them
      for (const [key, kp] of kalshiMap) {
        if (!localMap.has(key)) {
          const reconciledPosition = {
            orderId: `reconciled-${kp.ticker}-${kp.side}-${Date.now()}`,
            clientOrderId: 'reconciled',
            ticker: kp.ticker,
            type: 'RECONCILED',
            side: kp.side,
            contracts: kp.contracts,
            filledContracts: kp.contracts,
            priceCents: 0,
            priceDecimal: 0,
            totalCost: 0,
            edge: 0,
            modelProb: 0,
            reason: 'Reconciled from Kalshi portfolio',
            entryTime: Date.now(),
            closeTime: 0,
            status: 'executed',
            isDualSide: false,
          };
          this.state.openPositions.push(reconciledPosition);
          added++;
          this.log(`Reconciled: Found ${kp.contracts} ${kp.side.toUpperCase()} contracts on ${kp.ticker} (not in local state)`, 'WARN');
        }
      }

      // Positions in local state but NOT on Kalshi -> remove them
      const tickersToRemove = [];
      for (const [key, lp] of localMap) {
        if (!kalshiMap.has(key)) {
          for (const pos of lp.positions) {
            tickersToRemove.push(pos.orderId);
          }
          removed += lp.positions.length;
          this.log(`Reconciled: Removed ${lp.positions.length} local position(s) for ${key} (not on Kalshi)`, 'WARN');
        }
      }
      if (tickersToRemove.length > 0) {
        this.state.openPositions = this.state.openPositions.filter(
          p => !tickersToRemove.includes(p.orderId)
        );
      }

      if (added > 0 || removed > 0) {
        this.state.saveNow();
        this.log(`Reconciliation complete: ${added} added, ${removed} removed. ${this.state.openPositions.length} positions tracked.`, 'WARN');
      } else {
        this.log(`Reconciliation complete: positions in sync (${this.state.openPositions.length} tracked)`);
      }
    } catch (err) {
      this.log(`Position reconciliation error: ${err.message}`, 'ERROR');
      // Non-fatal - continue with local state
    }
  }

  async scan() {
    if (this.scanRunning || !this.running) return;
    this.scanRunning = true;

    try {
      // Refresh market prices — ALL IN PARALLEL
      const markets = this.state.activeMarkets;
      if (markets.length === 0) { this.scanRunning = false; return; }

      const results = await Promise.allSettled(
        markets.map(m => this.kalshi.fetchMarket(m.ticker))
      );

      const refreshedMarkets = markets.map((m, i) => {
        if (results[i].status === 'fulfilled' && results[i].value) {
          return { ...m, ...results[i].value };
        }
        return m; // Keep stale data on failure
      });

      this.state.updateMarkets(refreshedMarkets);

      // Update shared cache for checkTakeProfit()
      this._marketCache = { data: refreshedMarkets, ts: Date.now() };

      // Calculate unrealized P&L for open positions
      if (this.state.openPositions.length > 0) {
        let unrealized = 0;
        for (const pos of this.state.openPositions) {
          const market = refreshedMarkets.find(m => m.ticker === pos.ticker);
          if (!market) continue;
          const currentBid = pos.side === 'yes' ? (market.yesBid || 0) : (market.noBid || 0);
          unrealized += (currentBid - pos.priceDecimal) * (pos.filledContracts || pos.contracts);
        }
        this.state.updateUnrealizedPnL(unrealized);
      }

      // Generate trading signals
      const signals = this.strategy.generateSignals(
        refreshedMarkets,
        (closeTime) => this.polymarket.getCachedPrice(closeTime)
      );

      if (signals.length > 0) {
        const best = signals[0];
        this.state.updateIntent({
          status: 'signal_detected',
          message: `${best.type}: ${best.reason}`,
          lastSignal: best,
          modelProbability: best.modelProb,
          currentEdge: best.edge,
          action: `BUY ${best.side.toUpperCase()} @ ${best.priceCents}c`,
        });

        // Execute signals — cap per scan to prevent order flooding
        let lastTicker = null;
        let executedThisScan = 0;
        const maxExecutionsPerScan = 2;
        for (const signal of signals) {
          if (executedThisScan >= maxExecutionsPerScan) break;
          if (lastTicker === signal.ticker) await sleep(100);
          await this.executeSignal(signal);
          executedThisScan++;
          lastTicker = signal.ticker;
        }
      } else {
        this.state.updateIntent({
          status: 'scanning',
          message: 'Scanning for opportunities...',
          currentEdge: null,
          action: null,
        });
      }
    } catch (err) {
      this.log(`Scan error: ${err.message}`, 'ERROR');
    } finally {
      this.scanRunning = false;
    }
  }

  async executeSignal(signal) {
    // Check position limits (pending + open both count)
    const totalExposure = this.state.openPositions.length + this.state.pendingOrders.length;
    if (totalExposure >= this.maxOpenPositions) {
      this.db.logSignal(signal, false, 'max_positions');
      this.log('Max positions reached, skipping', 'WARN');
      return;
    }

    const existingOnTicker = [
      ...this.state.openPositions.filter(p => p.ticker === signal.ticker),
      ...this.state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    if (existingOnTicker.length >= this.maxPerContract) {
      this.db.logSignal(signal, false, 'per_contract_cap');
      return;
    }

    // Check balance
    const cost = signal.priceDecimal * signal.contracts;
    if (cost > this.state.balance.available) {
      this.db.logSignal(signal, false, 'insufficient_balance');
      this.log(`Insufficient balance for ${signal.ticker}`, 'WARN');
      return;
    }

    // Check cumulative dollar exposure on this ticker (prevent stacking)
    const existingCost = existingOnTicker.reduce((sum, p) => sum + (p.totalCost || p.reservedCost || 0), 0);
    if (existingCost + cost > this.maxPositionSize * 1.5) {
      this.db.logSignal(signal, false, 'ticker_exposure_cap');
      this.log(`Ticker exposure cap: ${signal.ticker} already $${existingCost.toFixed(2)}, rejecting $${cost.toFixed(2)}`, 'WARN');
      return;
    }

    // Log signal as executed
    const signalId = this.db.logSignal(signal, true);

    // Snapshot market state around execution
    const market = this.state.activeMarkets.find(m => m.ticker === signal.ticker);
    if (market) {
      this.db.logMarketSnapshot(market, this.state.btcPrice.binance, 'pre_execution');
    }

    try {
      const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

      const orderData = {
        ticker: signal.ticker,
        action: 'buy',
        side: signal.side,
        count: signal.contracts,
        type: 'limit',
        client_order_id: clientOrderId,
      };

      if (signal.side === 'yes') {
        orderData.yes_price = signal.priceCents;
      } else {
        orderData.no_price = signal.priceCents;
      }

      this.state.updateIntent({
        status: 'executing',
        message: `Executing ${signal.type}...`,
        action: `BUY ${signal.side.toUpperCase()} ${signal.ticker} x${signal.contracts} @ ${signal.priceCents}c`,
      });

      this.log(`Executing: ${signal.type} ${signal.ticker} ${signal.side} x${signal.contracts} @ ${signal.priceCents}c | Edge: ${signal.edge.toFixed(1)}%`);

      const order = await this.kalshi.placeOrder(orderData);

      this.log(`Order ${order.order_id}: ${order.status} | Filled: ${order.fill_count || 0}/${signal.contracts}`, 'SUCCESS');

      // Log order to SQLite
      this.db.logOrder({
        order_id: order.order_id,
        client_order_id: clientOrderId,
        ticker: signal.ticker,
        side: signal.side,
        action: 'buy',
        price_cents: signal.priceCents,
        count: signal.contracts,
        status: order.status,
        fill_count: order.fill_count || 0,
        taker_fill_cost: order.taker_fill_cost || 0,
        taker_fees: order.taker_fees || 0,
        close_time: signal.closeTime,
      }, signalId);

      // Add to pending orders — OrderManager will promote to openPositions on fill
      const pendingOrder = {
        orderId: order.order_id,
        clientOrderId,
        ticker: signal.ticker,
        signalType: signal.type,
        side: signal.side,
        contracts: signal.contracts,
        fillCount: order.fill_count || 0,
        priceCents: signal.priceCents,
        priceDecimal: signal.priceDecimal,
        reservedCost: cost,
        edge: signal.edge,
        modelProb: signal.modelProb,
        reason: signal.reason,
        placedAt: Date.now(),
        closeTime: signal.closeTime,
        orderStatus: order.status,
        isDualSide: signal.isDualSide || false,
      };

      this.orderManager.addPendingOrder(pendingOrder);

      // Immediately deduct cost from local balance (prevents race condition
      // where next scan sees stale balance before 15s API refresh)
      this.state.balance.available -= cost;
      if (this.state.balance.available < 0) this.state.balance.available = 0;

      this.state.stats.volumeTraded += cost;
      this.state.stats.totalEdge += signal.edge;
      this.state.stats.avgEdge = this.state.stats.totalEdge / (this.state.stats.totalTrades + this.state.openPositions.length || 1);

      this.state.logTrade({
        type: 'TRADE',
        action: 'BUY',
        side: signal.side,
        ticker: signal.ticker,
        contracts: signal.contracts,
        price: signal.priceCents,
        edge: signal.edge,
        signalType: signal.type,
        reason: signal.reason,
      });

      // Emit stats immediately so UI updates on execution
      this.state.emitStats();

      // Schedule settlement check (only for confirmed positions)
      const timeToSettle = signal.closeTime - Date.now() + 60000;
      if (timeToSettle > 0) {
        setTimeout(() => this.settlePosition(pendingOrder.orderId), timeToSettle);
      }

      // Refresh balance
      await this.kalshi.fetchBalance();

    } catch (err) {
      const detail = err.response
        ? `${err.response.status} - ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log(`Execution error: ${detail}`, 'ERROR');
    }
  }

  async checkTakeProfit() {
    if (!this.running || this.state.openPositions.length === 0) return;

    try {
      // Use cached market data from scan() — no redundant API calls
      const isCacheFresh = (Date.now() - this._marketCache.ts) < this._marketCacheTTL;
      const refreshed = isCacheFresh ? this._marketCache.data : this.state.activeMarkets;

      const tpSignals = this.strategy.generateTakeProfitSignals(
        this.state.openPositions,
        refreshed
      );

      for (const tp of tpSignals) {
        this.log(`Take profit: ${tp.ticker} ${tp.side} @ ${tp.sellPriceCents}c (+${tp.profitPct.toFixed(1)}%)`, 'SUCCESS');

        this.state.updateIntent({
          status: 'taking_profit',
          message: `Taking profit on ${tp.ticker}`,
          action: `SELL ${tp.side.toUpperCase()} @ ${tp.sellPriceCents}c`,
        });

        try {
          const sellOrder = await this.kalshi.sellPosition(
            tp.ticker,
            tp.side,
            tp.contracts,
            tp.sellPriceCents
          );

          if (sellOrder.status === 'executed' || sellOrder.fill_count > 0) {
            const pnl = ((tp.sellPriceDecimal - this.state.openPositions.find(p => p.orderId === tp.orderId)?.priceDecimal) || 0) * (sellOrder.fill_count || tp.contracts);

            this.state.closePosition(tp.orderId, {
              won: pnl > 0,
              pnl,
              payout: tp.sellPriceDecimal * (sellOrder.fill_count || tp.contracts),
              cost: this.state.openPositions.find(p => p.orderId === tp.orderId)?.totalCost || 0,
              exitType: 'TAKE_PROFIT',
            });

            this.state.logTrade({
              type: 'TRADE',
              action: 'SELL',
              side: tp.side,
              ticker: tp.ticker,
              contracts: tp.contracts,
              price: tp.sellPriceCents,
              pnl,
              reason: tp.reason,
            });

            this.log(`Sold: P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'SUCCESS' : 'WARN');
          }
        } catch (err) {
          this.log(`Take profit error: ${err.message}`, 'ERROR');
        }
      }
    } catch (err) {
      this.log(`Take profit scan error: ${err.message}`, 'ERROR');
    }
  }

  async settlePosition(orderId) {
    // Find the position — it may still be pending or already promoted
    const position = this.state.openPositions.find(p => p.orderId === orderId);
    if (!position) {
      // Check if still pending (unfilled) — clean up
      const pending = this.state.pendingOrders.find(p => p.orderId === orderId);
      if (pending) {
        this.log(`Order ${orderId} still pending at settlement time, removing`, 'WARN');
        this.state.removePendingOrder(orderId);
      }
      return;
    }

    try {
      const order = await this.kalshi.getOrder(orderId);
      const filled = order.fill_count || 0;

      if (filled === 0) {
        this.log(`Order ${orderId} never filled, removing`, 'WARN');
        this.state.openPositions = this.state.openPositions.filter(
          p => p.orderId !== orderId
        );
        this.state.emit('position:removed', position);
        return;
      }

      const market = await this.kalshi.fetchMarket(position.ticker);

      if (!market || (market.result !== 'yes' && market.result !== 'no')) {
        this.log(`${position.ticker} not settled yet, retrying in 30s`, 'WARN');
        setTimeout(() => this.settlePosition(orderId), 30000);
        return;
      }

      const won = position.side === market.result;
      const costCents = (order.taker_fill_cost || 0) + (order.taker_fees || 0);
      const costDollars = costCents / 100;
      const payout = won ? filled * 1.00 : 0;
      const pnl = payout - costDollars;

      // Update order in SQLite
      this.db.updateOrder(orderId, 'settled', filled, order.taker_fill_cost || 0, order.taker_fees || 0);

      // Snapshot market at settlement
      this.db.logMarketSnapshot(market, this.state.btcPrice.binance, 'settlement');

      this.state.closePosition(orderId, {
        won,
        pnl,
        payout,
        cost: costDollars,
        filledContracts: filled,
        exitType: 'SETTLEMENT',
        result: market.result,
      });

      this.state.logTrade({
        type: 'SETTLEMENT',
        action: won ? 'WIN' : 'LOSS',
        side: position.side,
        ticker: position.ticker,
        contracts: filled,
        pnl,
        cost: costDollars,
        payout,
        result: market.result,
      });

      this.log(
        `${won ? 'WON' : 'LOST'}: ${position.ticker} ${position.side} x${filled} | Cost: $${costDollars.toFixed(2)} | Payout: $${payout.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
        won ? 'SUCCESS' : 'ERROR'
      );

      await this.kalshi.fetchBalance();

    } catch (err) {
      this.log(`Settlement error: ${err.message}`, 'ERROR');
      // Retry
      setTimeout(() => this.settlePosition(orderId), 30000);
    }
  }

  stop() {
    this.running = false;
    this.binance.stop();
    this.polymarket.stop();
    this.redstone.stop();
    this.orderManager.stop();

    if (this.scanInterval) clearInterval(this.scanInterval);
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    if (this.balanceInterval) clearInterval(this.balanceInterval);
    if (this.takeProfitInterval) clearInterval(this.takeProfitInterval);

    this.state.updateIntent({
      status: 'stopped',
      message: 'Bot stopped',
    });

    this.log(`Shutdown. Trades: ${this.state.stats.totalTrades} | P&L: $${this.state.stats.totalPnL.toFixed(2)}`);

    this.db.close();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = BotEngine;
