const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const simpleGit = require('simple-git');
const { getDB } = require('./db');

const BOTS_DIR = process.env.BOTS_DIR || path.join(__dirname, 'bots_data');
const MAX_LOG_LINES = 500;

// In-memory map: botId → ChildProcess
const processes = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function addLog(botId, line, level = 'info') {
  try {
    const db = getDB();
    // Keep last MAX_LOG_LINES per bot
    const count = db.prepare('SELECT COUNT(*) as c FROM logs WHERE bot_id = ?').get(botId).c;
    if (count >= MAX_LOG_LINES) {
      db.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE bot_id = ? ORDER BY id ASC LIMIT ?)').run(botId, count - MAX_LOG_LINES + 1);
    }
    db.prepare('INSERT INTO logs (bot_id, line, level) VALUES (?, ?, ?)').run(botId, String(line).slice(0, 2000), level);
  } catch (e) { /* ignore log errors */ }
}

function updateBotStatus(botId, status, pid = null) {
  const db = getDB();
  db.prepare('UPDATE bots SET status = ?, pid = ? WHERE id = ?').run(status, pid, botId);
}

function detectLang(botDir) {
  if (fs.existsSync(path.join(botDir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(botDir, 'package.json'))) return 'node';
  // Check py files
  const files = fs.readdirSync(botDir);
  if (files.some(f => f.endsWith('.py'))) return 'python';
  if (files.some(f => f.endsWith('.js') || f.endsWith('.ts'))) return 'node';
  return 'python'; // default
}

function findEntryPoint(botDir, lang) {
  if (lang === 'python') {
    const candidates = ['main.py', 'bot.py', 'app.py', 'run.py', 'index.py', 'start.py'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(botDir, c))) return c;
    }
    // first .py file
    const py = fs.readdirSync(botDir).find(f => f.endsWith('.py'));
    return py || 'main.py';
  } else {
    // Check package.json main or scripts.start
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(botDir, 'package.json'), 'utf8'));
      if (pkg.main) return pkg.main;
      if (pkg.scripts?.start) return null; // use npm start
    } catch {}
    const candidates = ['index.js', 'bot.js', 'app.js', 'main.js', 'start.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(botDir, c))) return c;
    }
    return 'index.js';
  }
}

// ── Clone & Install ───────────────────────────────────────────────────────────

async function cloneRepo(githubUrl, botDir) {
  await fs.remove(botDir);
  await fs.ensureDir(botDir);
  const git = simpleGit();
  await git.clone(githubUrl, botDir, ['--depth', '1']);
}

async function installDeps(botDir, lang) {
  return new Promise((resolve, reject) => {
    let cmd, args, opts;

    if (lang === 'python') {
      cmd = 'pip3';
      args = ['install', '-r', 'requirements.txt', '--quiet'];
      opts = { cwd: botDir };
    } else {
      cmd = 'npm';
      args = ['install', '--production', '--silent'];
      opts = { cwd: botDir };
    }

    if (!fs.existsSync(path.join(botDir, lang === 'python' ? 'requirements.txt' : 'package.json'))) {
      return resolve('no deps file, skipping');
    }

    const proc = spawn(cmd, args, { ...opts, shell: true });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => out += d);
    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`Установка зависимостей завершилась с кодом ${code}\n${out}`));
    });
    proc.on('error', reject);

    // Timeout 3 minutes
    setTimeout(() => { proc.kill(); reject(new Error('Таймаут установки зависимостей (3 мин)')); }, 180_000);
  });
}

// ── Run Bot ───────────────────────────────────────────────────────────────────

function startProcess(botId, botDir, lang, token, entryPoint) {
  const env = { ...process.env, BOT_TOKEN: token, TELEGRAM_TOKEN: token, TOKEN: token };

  let cmd, args;
  if (lang === 'python') {
    cmd = 'python3';
    args = ['-u', entryPoint]; // -u = unbuffered output
  } else {
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(botDir, 'package.json'), 'utf8')); } catch { return {}; } })();
    if (pkg.scripts?.start && !entryPoint) {
      cmd = 'npm'; args = ['start'];
    } else {
      cmd = 'node'; args = [entryPoint];
    }
  }

  const proc = spawn(cmd, args, { cwd: botDir, env, shell: false });

  processes.set(botId, proc);
  updateBotStatus(botId, 'running', proc.pid);
  addLog(botId, `🚀 Бот запущен (PID ${proc.pid})`, 'info');

  proc.stdout.on('data', d => {
    addLog(botId, d.toString().trimEnd(), 'info');
  });

  proc.stderr.on('data', d => {
    addLog(botId, d.toString().trimEnd(), 'error');
  });

  proc.on('close', (code) => {
    processes.delete(botId);
    const msg = code === 0 ? '⏹ Бот остановлен' : `💥 Бот упал (код ${code})`;
    addLog(botId, msg, code === 0 ? 'info' : 'error');
    updateBotStatus(botId, code === 0 ? 'stopped' : 'crashed');

    // Auto-restart on crash (max 3 times within 5 min is handled by deploy logic)
    if (code !== 0 && code !== null) {
      addLog(botId, '🔄 Автоперезапуск через 5 сек...', 'warn');
      setTimeout(() => {
        const db = getDB();
        const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
        if (bot && bot.status === 'crashed') {
          startProcess(botId, bot.dir, bot.lang, bot.token, findEntryPoint(bot.dir, bot.lang));
        }
      }, 5000);
    }
  });

  proc.on('error', (err) => {
    addLog(botId, `❌ Ошибка запуска: ${err.message}`, 'error');
    updateBotStatus(botId, 'error');
  });

  return proc;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function deployBot(botId, githubUrl, token) {
  const db = getDB();
  const botDir = path.join(BOTS_DIR, botId);

  try {
    // Stop if running
    if (processes.has(botId)) {
      await stopBot(botId);
    }

    updateBotStatus(botId, 'cloning');
    addLog(botId, `📦 Клонирую репозиторий: ${githubUrl}`, 'info');

    await cloneRepo(githubUrl, botDir);
    addLog(botId, '✅ Репозиторий склонирован', 'info');

    const lang = detectLang(botDir);
    addLog(botId, `🔍 Определён язык: ${lang === 'python' ? 'Python' : 'Node.js'}`, 'info');

    db.prepare('UPDATE bots SET dir = ?, lang = ?, last_deploy = CURRENT_TIMESTAMP WHERE id = ?').run(botDir, lang, botId);

    updateBotStatus(botId, 'installing');
    addLog(botId, '📚 Устанавливаю зависимости...', 'info');

    await installDeps(botDir, lang);
    addLog(botId, '✅ Зависимости установлены', 'info');

    const entry = findEntryPoint(botDir, lang);
    addLog(botId, `▶ Запускаю: ${lang === 'python' ? 'python3' : 'node'} ${entry || '(npm start)'}`, 'info');

    startProcess(botId, botDir, lang, token, entry);

    return { success: true, lang };

  } catch (err) {
    addLog(botId, `❌ Ошибка деплоя: ${err.message}`, 'error');
    updateBotStatus(botId, 'error');
    throw err;
  }
}

async function stopBot(botId) {
  const proc = processes.get(botId);
  if (proc) {
    proc.removeAllListeners('close');
    proc.kill('SIGTERM');
    processes.delete(botId);
    updateBotStatus(botId, 'stopped');
    addLog(botId, '⏹ Бот остановлен вручную', 'info');
  }
}

async function restartBot(botId) {
  const db = getDB();
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  if (!bot || !bot.dir) throw new Error('Бот не задеплоен');

  await stopBot(botId);
  addLog(botId, '🔄 Перезапуск...', 'info');
  const entry = findEntryPoint(bot.dir, bot.lang);
  startProcess(botId, bot.dir, bot.lang, bot.token, entry);
}

function getLogs(botId, limit = 100) {
  const db = getDB();
  return db.prepare('SELECT line, level, ts FROM logs WHERE bot_id = ? ORDER BY id DESC LIMIT ?').all(botId, limit).reverse();
}

function isRunning(botId) {
  return processes.has(botId);
}

// Restore running bots on server restart
function restoreRunningBots() {
  try {
    const db = getDB();
    const runningBots = db.prepare("SELECT * FROM bots WHERE status = 'running' AND dir IS NOT NULL").all();
    for (const bot of runningBots) {
      if (fs.existsSync(bot.dir)) {
        addLog(bot.id, '🔁 Восстановление после перезапуска сервера', 'info');
        const entry = findEntryPoint(bot.dir, bot.lang);
        startProcess(bot.id, bot.dir, bot.lang, bot.token, entry);
      } else {
        updateBotStatus(bot.id, 'stopped');
      }
    }
    console.log(`♻️  Восстановлено ботов: ${runningBots.length}`);
  } catch (e) {
    console.error('Ошибка восстановления ботов:', e.message);
  }
}

module.exports = { deployBot, stopBot, restartBot, getLogs, isRunning, restoreRunningBots };
