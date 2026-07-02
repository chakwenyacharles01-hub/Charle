const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

let pool;

function getDatabaseConfig() {
  if (process.env.MYSQL_URL) {
    return process.env.MYSQL_URL;
  }

  return {
    host: process.env.MYSQLHOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER || 'netvend',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || 'netvend',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'netvend',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
    namedPlaceholders: false
  };
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool(getDatabaseConfig());
  }
  return pool;
}

async function exec(sql) {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await getPool().query(statement);
  }
}

async function get(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function run(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return {
    changes: result.affectedRows,
    lastInsertRowid: result.insertId
  };
}

function wrapConnection(connection) {
  return {
    get: async (sql, params = []) => {
      const [rows] = await connection.execute(sql, params);
      return rows[0];
    },
    all: async (sql, params = []) => {
      const [rows] = await connection.execute(sql, params);
      return rows;
    },
    run: async (sql, params = []) => {
      const [result] = await connection.execute(sql, params);
      return {
        changes: result.affectedRows,
        lastInsertRowid: result.insertId
      };
    }
  };
}

async function withTransaction(callback) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(wrapConnection(connection));
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function initDb() {
  await exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS packages (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      duration_minutes INT NOT NULL,
      download_speed VARCHAR(40),
      upload_speed VARCHAR(40),
      data_cap_mb INT,
      active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(32) UNIQUE NOT NULL,
      package_id INT NOT NULL,
      status ENUM('unused', 'used', 'expired') DEFAULT 'unused',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INT PRIMARY KEY AUTO_INCREMENT,
      package_id INT NOT NULL,
      method VARCHAR(40) NOT NULL,
      reference VARCHAR(120),
      phone VARCHAR(40),
      amount DECIMAL(10,2) NOT NULL,
      status ENUM('pending', 'confirmed', 'rejected') DEFAULT 'pending',
      voucher_code VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE TABLE IF NOT EXISTS sessions_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(120) NOT NULL,
      package_id INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      removed_from_router TINYINT(1) DEFAULT 0
    );
  `);

  const adminCount = await get('SELECT COUNT(*) AS c FROM admins');
  if (Number(adminCount.c) === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 10);
    await run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
    console.log(`Seeded default admin user "${username}" - please log in and change the password.`);
  }

  const pkgCount = await get('SELECT COUNT(*) AS c FROM packages');
  if (Number(pkgCount.c) === 0) {
    await run(
      'INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb) VALUES (?, ?, ?, ?, ?, ?)',
      ['1 Hour', 5, 60, '5M', '2M', null]
    );
    await run(
      'INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb) VALUES (?, ?, ?, ?, ?, ?)',
      ['1 Day', 15, 1440, '8M', '3M', null]
    );
    await run(
      'INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb) VALUES (?, ?, ?, ?, ?, ?)',
      ['1 Week', 80, 10080, '10M', '4M', null]
    );
    console.log('Seeded example packages.');
  }
}

module.exports = {
  initDb,
  get,
  all,
  run,
  exec,
  withTransaction
};

if (require.main === module) {
  initDb()
    .then(() => {
      console.log('Database initialized.');
      return getPool().end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
