const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const mikrotik = require('../config/mikrotik');
const { requireAdmin } = require('../middleware/auth');
const { generateCode, minutesToRouterosUptime } = require('../utils/voucherGen');

const router = express.Router();

// ---------- LOGIN ----------
router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  try {
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.render('admin/login', { error: 'Invalid username or password' });
    }
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    res.redirect('/admin/dashboard');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ---------- DASHBOARD ----------
router.get('/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const todayRevenue = (await db.get(`
      SELECT COALESCE(SUM(amount),0) AS total FROM payments
      WHERE status = 'confirmed' AND DATE(created_at) = CURDATE()
    `)).total;

    const monthRevenue = (await db.get(`
      SELECT COALESCE(SUM(amount),0) AS total FROM payments
      WHERE status = 'confirmed' AND DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')
    `)).total;

    const pendingPayments = (await db.get(`SELECT COUNT(*) AS c FROM payments WHERE status = 'pending'`)).c;
    const voucherStats = await db.all(`
      SELECT status, COUNT(*) AS c FROM vouchers GROUP BY status
    `);

    let activeUsers = [];
    let routerOnline = true;
    try {
      activeUsers = await mikrotik.getActiveUsers();
    } catch (err) {
      routerOnline = false;
    }

    res.render('admin/dashboard', {
      todayRevenue, monthRevenue, pendingPayments, voucherStats,
      activeUsers, routerOnline, adminUsername: req.session.adminUsername
    });
  } catch (err) {
    next(err);
  }
});

// ---------- PACKAGES ----------
router.get('/packages', requireAdmin, async (req, res, next) => {
  try {
    const packages = await db.all('SELECT * FROM packages ORDER BY price ASC');
    res.render('admin/packages', { packages, adminUsername: req.session.adminUsername });
  } catch (err) {
    next(err);
  }
});

router.post('/packages', requireAdmin, async (req, res, next) => {
  const { name, price, duration_minutes, download_speed, upload_speed, data_cap_mb } = req.body;
  try {
    await db.run(`
    INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb)
    VALUES (?, ?, ?, ?, ?, ?)
    `, [name, price, duration_minutes, download_speed || null, upload_speed || null, data_cap_mb || null]);
    res.redirect('/admin/packages');
  } catch (err) {
    next(err);
  }
});

router.post('/packages/:id/toggle', requireAdmin, async (req, res, next) => {
  try {
    await db.run('UPDATE packages SET active = NOT active WHERE id = ?', [req.params.id]);
    res.redirect('/admin/packages');
  } catch (err) {
    next(err);
  }
});

router.post('/packages/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await db.run('DELETE FROM packages WHERE id = ?', [req.params.id]);
    res.redirect('/admin/packages');
  } catch (err) {
    next(err);
  }
});

// ---------- VOUCHERS ----------
router.get('/vouchers', requireAdmin, async (req, res, next) => {
  try {
    const vouchers = await db.all(`
      SELECT v.*, p.name AS package_name FROM vouchers v
      JOIN packages p ON p.id = v.package_id
      ORDER BY v.created_at DESC LIMIT 200
    `);
    const packages = await db.all('SELECT * FROM packages WHERE active = 1');
    res.render('admin/vouchers', { vouchers, packages, adminUsername: req.session.adminUsername });
  } catch (err) {
    next(err);
  }
});

router.post('/vouchers/generate', requireAdmin, async (req, res, next) => {
  const { package_id, quantity } = req.body;
  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 500);
  const codes = [];
  try {
    await db.withTransaction(async (tx) => {
      for (let i = 0; i < qty; i++) {
        let code;
        do {
          code = generateCode(8);
        } while (await tx.get('SELECT 1 FROM vouchers WHERE code = ?', [code]));
        await tx.run('INSERT INTO vouchers (code, package_id) VALUES (?, ?)', [code, package_id]);
        codes.push(code);
      }
    });
    res.redirect('/admin/vouchers');
  } catch (err) {
    next(err);
  }
});

// Pre-load a voucher onto the router right away (optional - "activate on print")
// Most deployments instead activate a voucher the moment the customer redeems it
// via the portal. This endpoint exists if you prefer to push all vouchers to the
// router in advance.
router.post('/vouchers/:code/push-to-router', requireAdmin, async (req, res, next) => {
  try {
    const voucher = await db.get('SELECT * FROM vouchers WHERE code = ?', [req.params.code]);
    if (!voucher) return res.status(404).send('Voucher not found');
    const pkg = await db.get('SELECT * FROM packages WHERE id = ?', [voucher.package_id]);
    await mikrotik.createHotspotUser({
      username: voucher.code,
      password: voucher.code,
      limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
      dataCapMb: pkg.data_cap_mb
    });
    res.redirect('/admin/vouchers');
  } catch (err) {
    if (err.message) return res.status(500).send('Router error: ' + err.message);
    next(err);
  }
});

// ---------- PAYMENTS (mobile money confirmation queue) ----------
router.get('/payments', requireAdmin, async (req, res, next) => {
  try {
    const payments = await db.all(`
      SELECT p.*, pk.name AS package_name FROM payments p
      JOIN packages pk ON pk.id = p.package_id
      ORDER BY p.created_at DESC LIMIT 200
    `);
    res.render('admin/payments', { payments, adminUsername: req.session.adminUsername });
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:id/confirm', requireAdmin, async (req, res, next) => {
  try {
    const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!payment || payment.status !== 'pending') return res.redirect('/admin/payments');

    const pkg = await db.get('SELECT * FROM packages WHERE id = ?', [payment.package_id]);
    let code;
    do {
      code = generateCode(8);
    } while (await db.get('SELECT 1 FROM vouchers WHERE code = ?', [code]));

    await db.run('INSERT INTO vouchers (code, package_id, status) VALUES (?, ?, ?)', [code, pkg.id, 'used']);

    await mikrotik.createHotspotUser({
      username: code,
      password: code,
      limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
      dataCapMb: pkg.data_cap_mb
    });
    await db.run(`UPDATE payments SET status = 'confirmed', confirmed_at = NOW(), voucher_code = ? WHERE id = ?`, [code, payment.id]);
    res.redirect('/admin/payments');
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:id/reject', requireAdmin, async (req, res, next) => {
  try {
    await db.run(`UPDATE payments SET status = 'rejected' WHERE id = ?`, [req.params.id]);
    res.redirect('/admin/payments');
  } catch (err) {
    next(err);
  }
});

// ---------- ROUTER STATUS / SETTINGS TEST ----------
router.get('/router-status', requireAdmin, async (req, res) => {
  const result = await mikrotik.testConnection();
  res.render('admin/router-status', { result, adminUsername: req.session.adminUsername });
});

// ---------- CHANGE PASSWORD ----------
router.post('/change-password', requireAdmin, async (req, res, next) => {
  const { new_password } = req.body;
  const hash = bcrypt.hashSync(new_password, 10);
  try {
    await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.session.adminId]);
    res.redirect('/admin/dashboard');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
