require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');

const { initDB } = require('./db');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bots');
const { authenticateToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const deployLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Слишком много деплоев. Попробуйте через час.' } });

app.use(limiter);
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', authenticateToken, deployLimiter, botRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Serve frontend for all other routes ──────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await fs.ensureDir(process.env.BOTS_DIR || './bots_data');
  initDB();
  app.listen(PORT, () => {
    console.log(`\n🤖 BotNest backend запущен на http://localhost:${PORT}`);
    console.log(`📁 Боты хранятся в: ${path.resolve(process.env.BOTS_DIR || './bots_data')}\n`);
  });
}

start();
