const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'botnest.db');

let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      email     TEXT    UNIQUE NOT NULL,
      password  TEXT    NOT NULL,
      plan      TEXT    DEFAULT 'free',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bots (
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      github_url  TEXT    NOT NULL,
      token       TEXT    NOT NULL,
      lang        TEXT    NOT NULL DEFAULT 'python',
      status      TEXT    DEFAULT 'stopped',
      pid         INTEGER,
      dir         TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_deploy DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id   TEXT    NOT NULL,
      line     TEXT    NOT NULL,
      level    TEXT    DEFAULT 'info',
      ts       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
  `);

  console.log('✅ База данных инициализирована');
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

module.exports = { initDB, getDB };
