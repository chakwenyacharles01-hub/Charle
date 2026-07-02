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

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('admin/login', { error: 'Invalid username or password' });
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.redirect('/admin/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ---------- DASHBOARD ----------
router.get('/dashboard', requireAdmin, async (req, res) => {
  const todayRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM payments
    WHERE status = 'confirmed' AND date(created_at) = date('now')
  `).get().total;

  const monthRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM payments
    WHERE status = 'confirmed' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get().total;

  const pendingPayments = db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE status = 'pending'`).get().c;
  const voucherStats = db.prepare(`
    SELECT status, COUNT(*) AS c FROM vouchers GROUP BY status
  `).all();

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
});

// ---------- PACKAGES ----------
router.get('/packages', requireAdmin, (req, res) => {
  const packages = db.prepare('SELECT * FROM packages ORDER BY price ASC').all();
  res.render('admin/packages', { packages, adminUsername: req.session.adminUsername });
});

router.post('/packages', requireAdmin, (req, res) => {
  const { name, price, duration_minutes, download_speed, upload_speed, data_cap_mb } = req.body;
  db.prepare(`
    INSERT INTO packages (name, price, duration_minutes, download_speed, upload_speed, data_cap_mb)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, price, duration_minutes, download_speed || null, upload_speed || null, data_cap_mb || null);
  res.redirect('/admin/packages');
});

router.post('/packages/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE packages SET active = NOT active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM packages WHERE id = ?').run(req.params.id);
  res.redirect('/admin/packages');
});

// ---------- VOUCHERS ----------
router.get('/vouchers', requireAdmin, (req, res) => {
  const vouchers = db.prepare(`
    SELECT v.*, p.name AS package_name FROM vouchers v
    JOIN packages p ON p.id = v.package_id
    ORDER BY v.created_at DESC LIMIT 200
  `).all();
  const packages = db.prepare('SELECT * FROM packages WHERE active = 1').all();
  res.render('admin/vouchers', { vouchers, packages, adminUsername: req.session.adminUsername });
});

router.post('/vouchers/generate', requireAdmin, (req, res) => {
  const { package_id, quantity } = req.body;
  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 500);
  const insert = db.prepare('INSERT INTO vouchers (code, package_id) VALUES (?, ?)');
  const codes = [];
  const insertMany = db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      let code;
      // avoid collisions
      do {
        code = generateCode(8);
      } while (db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code));
      insert.run(code, package_id);
      codes.push(code);
    }
  });
  insertMany(qty);
  res.redirect('/admin/vouchers');
});

// Pre-load a voucher onto the router right away (optional - "activate on print")
// Most deployments instead activate a voucher the moment the customer redeems it
// via the portal. This endpoint exists if you prefer to push all vouchers to the
// router in advance.
router.post('/vouchers/:code/push-to-router', requireAdmin, async (req, res) => {
  const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(req.params.code);
  if (!voucher) return res.status(404).send('Voucher not found');
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(voucher.package_id);
  try {
    await mikrotik.createHotspotUser({
      username: voucher.code,
      password: voucher.code,
      limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
      dataCapMb: pkg.data_cap_mb
    });
    res.redirect('/admin/vouchers');
  } catch (err) {
    res.status(500).send('Router error: ' + err.message);
  }
});

// ---------- PAYMENTS (mobile money confirmation queue) ----------
router.get('/payments', requireAdmin, (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, pk.name AS package_name FROM payments p
    JOIN packages pk ON pk.id = p.package_id
    ORDER BY p.created_at DESC LIMIT 200
  `).all();
  res.render('admin/payments', { payments, adminUsername: req.session.adminUsername });
});

router.post('/payments/:id/confirm', requireAdmin, async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment || payment.status !== 'pending') return res.redirect('/admin/payments');

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(payment.package_id);
  let code;
  do {
    code = generateCode(8);
  } while (db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code));

  db.prepare('INSERT INTO vouchers (code, package_id, status) VALUES (?, ?, ?)').run(code, pkg.id, 'used');

  try {
    await mikrotik.createHotspotUser({
      username: code,
      password: code,
      limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
      dataCapMb: pkg.data_cap_mb
    });
    db.prepare(`UPDATE payments SET status = 'confirmed', confirmed_at = datetime('now'), voucher_code = ? WHERE id = ?`)
      .run(code, payment.id);
  } catch (err) {
    return res.status(500).send('Payment confirmed in records but router error occurred: ' + err.message + '. Voucher code: ' + code + ' (push it manually from the Vouchers page).');
  }
  res.redirect('/admin/payments');
});

router.post('/payments/:id/reject', requireAdmin, (req, res) => {
  db.prepare(`UPDATE payments SET status = 'rejected' WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/payments');
});

// ---------- ROUTER STATUS / SETTINGS TEST ----------
router.get('/router-status', requireAdmin, async (req, res) => {
  const result = await mikrotik.testConnection();
  res.render('admin/router-status', { result, adminUsername: req.session.adminUsername });
});

// ---------- CHANGE PASSWORD ----------
router.post('/change-password', requireAdmin, (req, res) => {
  const { new_password } = req.body;
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, req.session.adminId);
  res.redirect('/admin/dashboard');
});

module.exports = router;
