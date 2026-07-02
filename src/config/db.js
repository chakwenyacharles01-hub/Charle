const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbPath = path.join(__dirname, '..', '..', 'data', 'billing.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  duration_minutes INTEGER NOT NULL,
  download_speed TEXT,        -- e.g. '5M' (MikroTik rate-limit format)
  upload_speed TEXT,          -- e.g. '2M'
  data_cap_mb INTEGER,        -- NULL = unlimited
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  package_id INTEGER NOT NULL,
  status TEXT DEFAULT 'unused',   -- unused | used | expired
  created_at TEXT DEFAULT (datetime('now')),
  used_at TEXT,
  FOREIGN KEY(package_id) REFERENCES packages(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL,
  method TEXT NOT NULL,             -- cash | airtel | mtn | zamtel
  reference TEXT,                   -- mobile money transaction ref, or blank for cash
  phone TEXT,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending | confirmed | rejected
  voucher_code TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  confirmed_at TEXT,
  FOREIGN KEY(package_id) REFERENCES packages(id)
);

CREATE TABLE IF NOT EXISTS sessions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  package_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  removed_from_router INTEGER DEFAULT 0
);
`);

// Seed a default admin on first run
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
if (adminCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Seeded default admin user "${username}" - please log in and change the password.`);
}

// Seed a couple of example packages on first run
const pkgCount = db.prepare('SELECT COUNT(*) AS c FROM packages').get().c;
if (pkgCount === 0) {
  const insert = db.prepare(`INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb) VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run('1 Hour', 5, 60, '5M', '2M', null);
  insert.run('1 Day', 15, 1440, '8M', '3M', null);
  insert.run('1 Week', 80, 10080, '10M', '4M', null);
  console.log('Seeded example packages.');
}

module.exports = db;
