// KALSHIBOT Mission Control - Frontend

const socket = io();

// ========== State ==========
let state = {
  connections: {},
  btcPrice: {},
  balance: {},
  activeMarkets: [],
  openPositions: [],
  tradeLog: [],
  pnlHistory: [],
  intent: {},
  stats: {},
  model: {},
};

let startTime = null; // Set from server's persistent startTime

// ========== Restore from localStorage ==========
try {
  const savedPnl = localStorage.getItem('kalshibot_pnlHistory');
  if (savedPnl) {
    const parsed = JSON.parse(savedPnl);
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.pnlHistory = parsed;
    }
  }
  const savedStart = localStorage.getItem('kalshibot_startTime');
  if (savedStart) startTime = parseInt(savedStart, 10);
} catch (e) {
  // Ignore localStorage errors
}

// ========== DOM Elements ==========
const el = (id) => document.getElementById(id);

// ========== P&L Chart ==========
const ctx = document.getElementById('pnl-chart').getContext('2d');
const pnlChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Cumulative P&L',
      data: [],
      borderColor: '#00e5ff',
      backgroundColor: 'rgba(0, 229, 255, 0.05)',
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: '#00e5ff',
      pointBorderColor: 'transparent',
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0d0f17',
        borderColor: '#2a2d4e',
        borderWidth: 1,
        titleColor: '#6b6f85',
        bodyColor: '#e0e0e8',
        bodyFont: { family: 'monospace' },
      },
    },
    scales: {
      x: {
        display: true,
        grid: { color: 'rgba(26, 29, 46, 0.5)' },
        ticks: { color: '#444766', font: { size: 9 }, maxTicksLimit: 8 },
      },
      y: {
        display: true,
        grid: { color: 'rgba(26, 29, 46, 0.5)' },
        ticks: {
          color: '#6b6f85',
          font: { size: 10 },
          callback: v => '$' + v.toFixed(2),
        },
      },
    },
  },
});

// Render chart from restored localStorage data on load
if (state.pnlHistory.length > 0) {
  updateChart(state.pnlHistory);
}

// ========== Update Functions ==========
function updateConnections(conns) {
  const dots = {
    binance: 'dot-binance',
    polymarket: 'dot-polymarket',
    kalshi: 'dot-kalshi',
    redstone: 'dot-redstone',
  };
  for (const [key, dotId] of Object.entries(dots)) {
    const dot = el(dotId);
    if (dot) {
      dot.classList.toggle('active', !!conns[key]);
    }
  }
}

function updateBtcPrice(price) {
  const btcEl = el('btc-price');
  const srcEl = el('btc-source');
  if (!price) return;

  if (price.binance) {
    btcEl.textContent = '$' + Number(price.binance).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    srcEl.textContent = price.redstone
      ? `Binance | RS: $${Number(price.redstone).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'Binance Live';
  } else if (price.redstone) {
    btcEl.textContent = '$' + Number(price.redstone).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    srcEl.textContent = 'RedStone Oracle';
  }
}

function updatePnL(stats) {
  const pnlEl = el('total-pnl');
  const pnl = stats.totalPnL || 0;
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
  pnlEl.className = 'metric-value ' + (pnl >= 0 ? 'positive' : 'negative');

  el('win-loss').textContent = `${stats.wins || 0}W / ${stats.losses || 0}L`;

  // ROI
  const volume = stats.volumeTraded || 1;
  const roi = (pnl / volume) * 100;
  const roiEl = el('roi-value');
  roiEl.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
  roiEl.className = 'metric-value ' + (roi >= 0 ? 'positive' : 'negative');

  el('trades-per-hour').textContent = (stats.tradesPerHour || 0).toFixed(1) + ' trades/hr';
}

function updateBalance(bal) {
  if (!bal) return;
  el('balance-value').textContent = '$' + (bal.total || 0).toFixed(2);
  el('balance-available').textContent = '$' + (bal.available || 0).toFixed(2) + ' available';
}

function updateIntent(intent) {
  if (!intent) return;

  el('intent-message').textContent = intent.message || '--';
  el('intent-action').textContent = intent.action || '--';
  el('intent-prob').textContent = intent.modelProbability != null
    ? (intent.modelProbability * 100).toFixed(1) + '%'
    : '--';
  el('intent-edge').textContent = intent.currentEdge != null
    ? intent.currentEdge.toFixed(1) + '%'
    : '--';

  const badge = el('bot-status');
  badge.textContent = (intent.status || 'unknown').toUpperCase().replace(/_/g, ' ');
  badge.className = 'status-badge ' + (intent.status || '');
}

function updateModel(model) {
  if (!model) return;

  el('intent-move').textContent = model.spotMovePct != null
    ? (model.spotMovePct >= 0 ? '+' : '') + model.spotMovePct.toFixed(4) + '%'
    : '--';
  el('intent-vol').textContent = model.volatility != null
    ? (model.volatility * 100).toFixed(3) + '%'
    : '--';
  el('intent-time').textContent = model.timeRemaining != null
    ? Math.floor(model.timeRemaining) + 's'
    : '--';

  // Color the move
  const moveEl = el('intent-move');
  if (model.spotMovePct > 0) moveEl.classList.add('positive');
  else if (model.spotMovePct < 0) moveEl.classList.add('negative');

  // 1H Trend indicator
  const trendEl = el('intent-trend');
  if (trendEl) {
    if (!model.trendWarmup) {
      trendEl.textContent = 'WARMING UP';
      trendEl.className = 'detail-value trend-warmup';
    } else {
      const arrow = model.trend === 'BULLISH' ? '\u2191' : model.trend === 'BEARISH' ? '\u2193' : '\u2194';
      const rocStr = model.trendROC != null ? ' (' + (model.trendROC >= 0 ? '+' : '') + model.trendROC.toFixed(3) + '%)' : '';
      trendEl.textContent = arrow + ' ' + model.trend + rocStr;
      trendEl.className = 'detail-value trend-' + model.trend.toLowerCase();
    }
  }
}

function updatePositions(positions) {
  const list = el('positions-list');
  el('pos-count').textContent = positions.length;
  el('stat-open').textContent = positions.length;

  if (positions.length === 0) {
    list.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  list.innerHTML = positions.map(p => `
    <div class="position-card">
      <span class="pos-ticker" title="${p.ticker}">${p.ticker.split('-').slice(-2).join('-')}</span>
      <span class="pos-side ${p.side}">${p.side.toUpperCase()}</span>
      <span class="pos-info">x${p.filledContracts || p.contracts} @ ${p.priceCents}¢</span>
      <span class="pos-info">$${(p.totalCost || 0).toFixed(2)}</span>
      <span class="pos-edge">${p.edge ? p.edge.toFixed(1) + '%' : '--'}</span>
      <span class="pos-info">${p.type || ''}</span>
    </div>
  `).join('');
}

function updateMarkets(markets) {
  const body = el('markets-body');
  el('market-count').textContent = markets.length;

  if (markets.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No active markets</td></tr>';
    return;
  }

  body.innerHTML = markets.map(m => {
    const combined = (m.yesAsk || 0) + (m.noAsk || 0);
    const combinedClass = combined < 0.98 ? 'combined-good' : 'combined-bad';
    const timeStr = m.secondsUntilClose != null
      ? formatTime(m.secondsUntilClose)
      : (m.minutesUntilClose || '?') + 'm';

    return `
      <tr>
        <td style="color: var(--accent)">${m.ticker.split('-').slice(-2).join('-')}</td>
        <td>${cents(m.yesBid)} / ${cents(m.yesAsk)}</td>
        <td>${cents(m.noBid)} / ${cents(m.noAsk)}</td>
        <td class="${combinedClass}">${(combined * 100).toFixed(0)}¢</td>
        <td>${timeStr}</td>
        <td style="color: var(--green)">${m.status || 'open'}</td>
      </tr>
    `;
  }).join('');
}

function updateTradeLog(log) {
  const logEl = el('trade-log');
  el('log-count').textContent = log.length;

  if (log.length === 0) {
    logEl.innerHTML = '<div class="empty-state">No trades yet</div>';
    return;
  }

  // Show only last 30 entries for performance
  const recent = log.slice(0, 30);

  logEl.innerHTML = recent.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    let typeClass = entry.type || 'LOG';
    let msg = '';

    if (entry.type === 'TRADE') {
      typeClass = entry.action || 'BUY';
      msg = `${entry.side?.toUpperCase() || ''} ${shortTicker(entry.ticker)} x${entry.contracts || 0} @ ${entry.price || 0}¢`;
      if (entry.pnl != null) msg += ` | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
      if (entry.edge) msg += ` | Edge: ${entry.edge.toFixed(1)}%`;
    } else if (entry.type === 'SETTLEMENT') {
      typeClass = entry.action || 'WIN';
      msg = `${shortTicker(entry.ticker)} ${entry.side?.toUpperCase()} x${entry.contracts} | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
    } else {
      msg = entry.message || '';
    }

    return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="log-type ${typeClass}">${typeClass}</span>
        <span class="log-msg">${msg}</span>
      </div>
    `;
  }).join('');
}

function updateStats(stats) {
  el('stat-trades').textContent = stats.totalTrades || 0;

  const total = (stats.wins || 0) + (stats.losses || 0);
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : '0';
  el('stat-winrate').textContent = winRate + '%';

  el('stat-avgedge').textContent = (stats.avgEdge || 0).toFixed(1) + '%';

  const bestEl = el('stat-best');
  bestEl.textContent = '+$' + (stats.bestTrade || 0).toFixed(2);
  bestEl.className = 'stat-value positive';

  const worstEl = el('stat-worst');
  worstEl.textContent = (stats.worstTrade < 0 ? '-' : '') + '$' + Math.abs(stats.worstTrade || 0).toFixed(2);
  worstEl.className = 'stat-value ' + (stats.worstTrade < 0 ? 'negative' : 'neutral');

  el('stat-volume').textContent = '$' + (stats.volumeTraded || 0).toFixed(2);
  el('stat-tph').textContent = (stats.tradesPerHour || 0).toFixed(1);

  // Profit factor
  const pfEl = el('stat-profitfactor');
  if (pfEl) {
    const pf = (stats.grossLosses || 0) > 0
      ? (stats.grossWins / stats.grossLosses)
      : (stats.grossWins > 0 ? Infinity : 0);
    pfEl.textContent = pf === Infinity ? 'INF' : pf.toFixed(2);
    pfEl.className = 'stat-value ' + (pf >= 1 ? 'positive' : 'negative');
  }

  // Avg win / avg loss
  const avgWinEl = el('stat-avgwin');
  if (avgWinEl) {
    const avgWin = (stats.wins || 0) > 0 ? (stats.grossWins || 0) / stats.wins : 0;
    avgWinEl.textContent = '+$' + avgWin.toFixed(2);
  }
  const avgLossEl = el('stat-avgloss');
  if (avgLossEl) {
    const avgLoss = (stats.losses || 0) > 0 ? (stats.grossLosses || 0) / stats.losses : 0;
    avgLossEl.textContent = '-$' + avgLoss.toFixed(2);
  }

  // Streak
  const streakEl = el('stat-streak');
  if (streakEl) {
    const streak = stats.streak || 0;
    streakEl.textContent = (streak > 0 ? '+' : '') + streak;
    streakEl.className = 'stat-value ' + (streak > 0 ? 'positive' : streak < 0 ? 'negative' : 'neutral');
  }

  // Unrealized P&L
  const unrealizedEl = el('stat-unrealized');
  if (unrealizedEl) {
    const uPnl = stats.unrealizedPnL || 0;
    unrealizedEl.textContent = (uPnl >= 0 ? '+' : '') + '$' + uPnl.toFixed(2);
    unrealizedEl.className = 'stat-value ' + (uPnl >= 0 ? 'positive' : 'negative');
  }

  // Strategy breakdown
  const stratEl = el('stat-strategy');
  if (stratEl && stats.strategyStats) {
    const parts = Object.entries(stats.strategyStats).map(([k, v]) => {
      const short = k.replace('DIRECTIONAL', 'DIR').replace('POLY_ARB', 'POLY').replace('DUAL_SIDE', 'DUAL');
      return `${short}: ${v.wins}W/${v.losses}L`;
    });
    stratEl.textContent = parts.length > 0 ? parts.join(' | ') : '--';
  }
}

function updateChart(pnlHistory) {
  if (!pnlHistory || pnlHistory.length === 0) return;

  // Persist to localStorage for page refresh survival
  try {
    localStorage.setItem('kalshibot_pnlHistory', JSON.stringify(pnlHistory.slice(-500)));
  } catch (e) {
    // localStorage might be full or disabled
  }

  const labels = pnlHistory.map(p =>
    new Date(p.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  );
  const data = pnlHistory.map(p => p.cumulative);

  pnlChart.data.labels = labels;
  pnlChart.data.datasets[0].data = data;

  // Color based on P&L
  const lastPnl = data[data.length - 1] || 0;
  const color = lastPnl >= 0 ? '#00e676' : '#ff1744';
  const bgColor = lastPnl >= 0 ? 'rgba(0, 230, 118, 0.05)' : 'rgba(255, 23, 68, 0.05)';

  pnlChart.data.datasets[0].borderColor = color;
  pnlChart.data.datasets[0].backgroundColor = bgColor;
  pnlChart.data.datasets[0].pointBackgroundColor = color;

  pnlChart.update('none');

  el('chart-total').textContent = (lastPnl >= 0 ? '+' : '') + '$' + lastPnl.toFixed(2);
}

// ========== Utilities ==========
function cents(val) {
  if (val == null) return '--';
  return Math.round(val * 100) + '¢';
}

function shortTicker(ticker) {
  if (!ticker) return '';
  const parts = ticker.split('-');
  return parts.length > 2 ? parts.slice(-2).join('-') : ticker;
}

function formatTime(seconds) {
  if (seconds < 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ========== Uptime Timer ==========
setInterval(() => {
  if (!startTime) {
    el('uptime').textContent = '00:00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  el('uptime').textContent = `${h}:${m}:${s}`;
}, 1000);

// ========== Bot Toggle ==========
let botRunning = false;
const toggleBtn = el('bot-toggle');
const toggleIcon = el('toggle-icon');
const toggleLabel = el('toggle-label');

function updateToggleUI(running) {
  botRunning = running;
  if (running) {
    toggleBtn.classList.add('running');
    toggleBtn.classList.remove('stopped');
    toggleIcon.innerHTML = '&#9632;'; // stop square
    toggleLabel.textContent = 'STOP';
  } else {
    toggleBtn.classList.remove('running');
    toggleBtn.classList.add('stopped');
    toggleIcon.innerHTML = '&#9654;'; // play triangle
    toggleLabel.textContent = 'START';
  }
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  toggleLabel.textContent = botRunning ? 'STOPPING...' : 'STARTING...';
  try {
    const endpoint = botRunning ? '/api/bot/stop' : '/api/bot/start';
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'error') {
      console.error('Bot toggle error:', data.message);
    }
  } catch (err) {
    console.error('Bot toggle failed:', err);
  } finally {
    toggleBtn.disabled = false;
  }
});

// ========== Socket.io Handlers ==========
socket.on('connect', () => {
  console.log('Connected to Kalshibot server');
});

socket.on('snapshot', (data) => {
  // Merge P&L history: keep whichever is longer/more complete
  if (state.pnlHistory && state.pnlHistory.length > 0 && data.pnlHistory) {
    if (data.pnlHistory.length >= state.pnlHistory.length) {
      state.pnlHistory = data.pnlHistory;
    }
    // else: keep client's existing pnlHistory (accumulated during session)
  } else {
    state.pnlHistory = data.pnlHistory || [];
  }

  // Always take authoritative data from server
  state.connections = data.connections;
  state.btcPrice = data.btcPrice;
  state.balance = data.balance;
  state.activeMarkets = data.activeMarkets || [];
  state.openPositions = data.openPositions || [];
  state.tradeLog = data.tradeLog || [];
  state.intent = data.intent || {};
  state.stats = data.stats || {};
  state.model = data.model || {};

  // Reconcile: if server stats show $0 P&L but pnlHistory has data, use pnlHistory's cumulative
  if ((!state.stats.totalPnL || state.stats.totalPnL === 0) && state.pnlHistory.length > 0) {
    const lastEntry = state.pnlHistory[state.pnlHistory.length - 1];
    if (lastEntry && lastEntry.cumulative && lastEntry.cumulative !== 0) {
      state.stats.totalPnL = lastEntry.cumulative;
      // Also reconstruct win/loss counts from pnlHistory if stats are stale
      if (!state.stats.totalTrades || state.stats.totalTrades === 0) {
        let wins = 0, losses = 0;
        for (const entry of state.pnlHistory) {
          if (entry.pnl > 0) wins++;
          else if (entry.pnl < 0) losses++;
        }
        state.stats.totalTrades = state.pnlHistory.length;
        state.stats.wins = wins;
        state.stats.losses = losses;
      }
    }
  }

  // Use persistent startTime from server (original session start)
  startTime = data.startTime || data.stats?.startTime || startTime;
  if (startTime) {
    try { localStorage.setItem('kalshibot_startTime', String(startTime)); } catch(e) {}
  }

  updateConnections(data.connections);
  updateBtcPrice(data.btcPrice);
  updatePnL(state.stats);
  updateBalance(data.balance);
  updateIntent(data.intent);
  updateModel(data.model);
  updatePositions(state.openPositions);
  updateMarkets(state.activeMarkets);
  updateTradeLog(state.tradeLog);
  updateStats(state.stats);
  updateChart(state.pnlHistory);
});

socket.on('price:binance', (data) => {
  state.btcPrice = { ...state.btcPrice, binance: data.mid, binanceBid: data.bid, binanceAsk: data.ask };
  state.connections.binance = true;
  updateBtcPrice(state.btcPrice);
  updateConnections(state.connections);
});

socket.on('price:redstone', (data) => {
  state.btcPrice = { ...state.btcPrice, redstone: data.price };
  updateBtcPrice(state.btcPrice);
  updateConnections({ ...state.connections, redstone: true });
});

socket.on('balance', (data) => {
  state.balance = data;
  updateBalance(data);
});

socket.on('markets', (data) => {
  state.activeMarkets = data;
  updateMarkets(data);
  // Markets refreshed = Kalshi connection alive
  if (data && data.length > 0) {
    state.connections.kalshi = true;
    updateConnections(state.connections);
  }
});

socket.on('intent', (data) => {
  state.intent = data;
  updateIntent(data);
});

socket.on('model', (data) => {
  state.model = data;
  updateModel(data);
});

socket.on('trade', (data) => {
  state.tradeLog.unshift(data);
  if (state.tradeLog.length > 50) state.tradeLog.pop();
  updateTradeLog(state.tradeLog);
});

socket.on('position:open', (data) => {
  state.openPositions.push(data);
  updatePositions(state.openPositions);
});

socket.on('position:close', (data) => {
  state.openPositions = state.openPositions.filter(p => p.orderId !== data.orderId);
  updatePositions(state.openPositions);
  state.pnlHistory.push({ timestamp: Date.now(), pnl: data.pnl, cumulative: (state.stats?.totalPnL || 0) });
  updateChart(state.pnlHistory);
});

socket.on('stats', (data) => {
  state.stats = data;
  updatePnL(data);
  updateStats(data);
});

socket.on('connection:kalshi', (connected) => {
  state.connections = { ...state.connections, kalshi: connected };
  updateConnections(state.connections);
});

socket.on('connection:polymarket', (connected) => {
  state.connections = { ...state.connections, polymarket: connected };
  updateConnections(state.connections);
});

socket.on('connection:binance', (connected) => {
  state.connections = { ...state.connections, binance: connected };
  updateConnections(state.connections);
});

socket.on('bot:status', (data) => {
  updateToggleUI(data.running);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  updateToggleUI(false);
  updateConnections({ binance: false, polymarket: false, kalshi: false, redstone: false });
});
