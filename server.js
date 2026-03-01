#!/usr/bin/env node

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const BotEngine = require('./bot/engine');

const PORT = process.env.PORT || 3333;

// Build config from env
const config = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com',

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  SERIES_TICKER: process.env.SERIES_TICKER || 'KXBTC15M',
  SLOT_DURATION: parseInt(process.env.SLOT_DURATION) || 900, // 15 min

  // Strategy thresholds
  MIN_EDGE: parseFloat(process.env.MIN_EDGE) || 10.0,
  MIN_DIVERGENCE: parseFloat(process.env.MIN_DIVERGENCE) || 10.0,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 4, // minutes
  MIN_CONTRACT_PRICE: parseInt(process.env.MIN_CONTRACT_PRICE) || 48, // cents
  MAX_CONTRACT_PRICE: parseInt(process.env.MAX_CONTRACT_PRICE) || 88, // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: parseInt(process.env.TREND_FAST_PERIOD) || 720,     // 12 min
  TREND_SLOW_PERIOD: parseInt(process.env.TREND_SLOW_PERIOD) || 2700,    // 45 min
  TREND_ROC_WINDOW: parseInt(process.env.TREND_ROC_WINDOW) || 1800,      // 30 min
  TREND_ROC_THRESHOLD: parseFloat(process.env.TREND_ROC_THRESHOLD) || 0.02,
  TREND_BOOST: parseFloat(process.env.TREND_BOOST) || 0.25,
  TREND_PENALTY: parseFloat(process.env.TREND_PENALTY) || 0.40,

  // Position sizing
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.25,
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE) || 25,
  MAX_POSITIONS_PER_CONTRACT: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT) || 1,
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS) || 10,
};

// Express + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (engine && engine.state) {
    res.json(engine.state.getSnapshot());
  } else {
    res.json({ error: 'Engine not started' });
  }
});

// API: force save state to disk
app.post('/api/save', (req, res) => {
  if (engine && engine.state) {
    engine.state.saveNow();
    res.json({ status: 'saved' });
  } else {
    res.json({ error: 'Engine not started' });
  }
});

// Start bot engine
const engine = new BotEngine(config);

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('snapshot', engine.state.getSnapshot());

  // Forward state events to this socket
  const events = [
    'price:binance', 'price:redstone', 'balance', 'markets',
    'intent', 'model', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
  ];

  const handlers = {};
  for (const event of events) {
    handlers[event] = (data) => socket.emit(event, data);
    engine.state.on(event, handlers[event]);
  }

  // No periodic snapshot push — rely on event forwarding + snapshot on connect

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        engine.state.removeListener(event, handlers[event]);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then bot
server.listen(PORT, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  engine.start().catch(err => {
    console.error('[Engine] Failed to start:', err.message);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  engine.state.saveNow();
  engine.stop();
  server.close();
  process.exit(0);
});
