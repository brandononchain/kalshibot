#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 *
 * Architecture:
 *   server.js → MasterAgent → Orchestrator → Skills
 *
 * The legacy BotEngine is preserved at `node kalshi-bot.js` for fallback.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MasterAgent } = require('./agents');

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
  // Backtest-optimized: higher threshold to filter overconfident signals
  MIN_DIVERGENCE: parseFloat(process.env.MIN_DIVERGENCE) || 15.0,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 4, // minutes
  // Backtest-optimized: contracts above 65c have terrible payoff ratio
  MIN_CONTRACT_PRICE: parseInt(process.env.MIN_CONTRACT_PRICE) || 35, // cents
  MAX_CONTRACT_PRICE: parseInt(process.env.MAX_CONTRACT_PRICE) || 65, // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: parseInt(process.env.TREND_FAST_PERIOD) || 720,     // 12 min
  TREND_SLOW_PERIOD: parseInt(process.env.TREND_SLOW_PERIOD) || 2700,    // 45 min
  TREND_ROC_WINDOW: parseInt(process.env.TREND_ROC_WINDOW) || 1800,      // 30 min
  TREND_ROC_THRESHOLD: parseFloat(process.env.TREND_ROC_THRESHOLD) || 0.02,
  TREND_BOOST: parseFloat(process.env.TREND_BOOST) || 0.25,
  TREND_PENALTY: parseFloat(process.env.TREND_PENALTY) || 0.40,

  // Position sizing
  // Backtest-optimized: conservative Kelly to survive binary option variance
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.08,
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE) || 5,
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

// Create the MasterAgent
const agent = new MasterAgent(config);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), botRunning: agent.running });
});

// Bot control: start/stop
app.post('/api/bot/start', async (req, res) => {
  if (agent.running) {
    return res.json({ status: 'already_running' });
  }
  try {
    await agent.start();
    io.emit('bot:status', { running: true });
    res.json({ status: 'started' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/bot/stop', (req, res) => {
  if (!agent.running) {
    return res.json({ status: 'already_stopped' });
  }
  agent.stop();
  io.emit('bot:status', { running: false });
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', (req, res) => {
  res.json({ running: agent.running });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (agent && agent.state) {
    res.json(agent.state.getSnapshot());
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: force save state to disk
app.post('/api/save', (req, res) => {
  if (agent && agent.state) {
    agent.state.saveNow();
    res.json({ status: 'saved' });
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: ML pipeline status
app.get('/api/ml', (req, res) => {
  const mlScorer = agent.registry.get('ml-signal-scorer');
  if (mlScorer) {
    const mlPipeline = require('./lib/ml-pipeline');
    res.json(mlPipeline.describe());
  } else {
    res.json({ trained: false, note: 'ML scorer not initialized' });
  }
});

// API: get agent skill registry status
app.get('/api/skills', (req, res) => {
  res.json({
    skills: agent.registry.describeAll(),
    orchestrator: agent.orchestrator.describe(),
  });
});

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('bot:status', { running: agent.running });
  if (agent.state) {
    socket.emit('snapshot', agent.state.getSnapshot());
  }

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
    if (agent.state) {
      agent.state.on(event, handlers[event]);
    }
  }

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        if (agent.state) {
          agent.state.removeListener(event, handlers[event]);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then agent
server.listen(PORT, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  // Bot does NOT auto-start — user controls via dashboard toggle
  console.log('  Bot is IDLE. Use the dashboard toggle to start trading.\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  if (agent.state) agent.state.saveNow();
  agent.stop();
  server.close();
  process.exit(0);
});
