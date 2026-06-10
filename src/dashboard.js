const express = require('express');
const path    = require('path');
const { loadHistory } = require('./snapshot');

const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));

// API endpoint for the dashboard to fetch change history
app.get('/api/history', (req, res) => {
  const history = loadHistory();
  res.json(history);
});

// API endpoint for health check / last check info
app.get('/api/status', (req, res) => {
  const history = loadHistory();
  res.json({
    status: 'running',
    lastCheck: history[0]?.checkedAt || null,
    totalEventsLogged: history.length,
  });
});

function startDashboard() {
  const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`🌐 Dashboard running at http://localhost:${port}`);
  });
}

module.exports = { startDashboard };
