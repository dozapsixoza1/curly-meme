const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../db');
const { deployBot, stopBot, restartBot, getLogs, isRunning } = require('../botManager');

const router = express.Router();

const PLAN_LIMITS = { free: 1, starter: 5, pro: Infinity };

// GET /api/bots — список ботов пользователя
router.get('/', (req, res) => {
  const db = getDB();
  const bots = db.prepare('SELECT id, name, github_url, lang, status, created_at, last_deploy FROM bots WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  // Sync live status
  const enriched = bots.map(b => ({ ...b, live: isRunning(b.id) }));
  res.json(enriched);
});

// POST /api/bots — создать и задеплоить бота
router.post('/', async (req, res) => {
  try {
    const { name, github_url, token } = req.body;

    if (!name || !github_url || !token) {
      return res.status(400).json({ error: 'Нужны: name, github_url, token' });
    }

    // Validate github URL
    if (!/^https?:\/\/(www\.)?github\.com\/.+\/.+/.test(github_url)) {
      return res.status(400).json({ error: 'Неверная ссылка GitHub. Формат: https://github.com/user/repo' });
    }

    // Validate bot token format
    if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
      return res.status(400).json({ error: 'Неверный формат токена бота' });
    }

    const db = getDB();

    // Check plan limits
    const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
    const limit = PLAN_LIMITS[user?.plan || 'free'];
    const count = db.prepare('SELECT COUNT(*) as c FROM bots WHERE user_id = ?').get(req.user.id).c;

    if (count >= limit) {
      return res.status(403).json({
        error: `Лимит тарифа: максимум ${limit} бот(а). Перейдите на платный тариф.`
      });
    }

    const botId = uuidv4();
    db.prepare(`
      INSERT INTO bots (id, user_id, name, github_url, token, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(botId, req.user.id, name.slice(0, 50), github_url, token);

    // Deploy async — respond immediately
    res.status(202).json({ id: botId, message: 'Деплой начат' });

    // Run deploy in background
    deployBot(botId, github_url, token).catch(err => {
      console.error(`Deploy error for ${botId}:`, err.message);
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bots/:id — статус бота
router.get('/:id', (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT id, name, github_url, lang, status, created_at, last_deploy FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  res.json({ ...bot, live: isRunning(bot.id) });
});

// POST /api/bots/:id/stop
router.post('/:id/stop', async (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });

  await stopBot(req.params.id);
  res.json({ success: true });
});

// POST /api/bots/:id/restart
router.post('/:id/restart', async (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });

  try {
    await restartBot(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/bots/:id/redeploy — pull latest and restart
router.post('/:id/redeploy', async (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });

  res.status(202).json({ message: 'Редеплой начат' });
  deployBot(bot.id, bot.github_url, bot.token).catch(console.error);
});

// GET /api/bots/:id/logs
router.get('/:id/logs', (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = getLogs(req.params.id, limit);
  res.json(logs);
});

// DELETE /api/bots/:id
router.delete('/:id', async (req, res) => {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });

  await stopBot(req.params.id);

  // Clean up files
  const fs = require('fs-extra');
  if (bot.dir) await fs.remove(bot.dir).catch(() => {});

  db.prepare('DELETE FROM bots WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
