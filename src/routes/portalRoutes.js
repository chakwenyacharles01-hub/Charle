const express = require('express');
const db = require('../config/db');
const mikrotik = require('../config/mikrotik');
const { generateCode, minutesToRouterosUptime } = require('../utils/voucherGen');

const router = express.Router();

// The MikroTik hotspot redirects unauthenticated clients here.
// It passes along params like ?mac=...&ip=...&link-login=... which we
// forward through so we can auto-submit the login form after purchase.
router.get('/', (req, res) => {
  const packages = db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price ASC').all();
  res.render('portal/index', {
    packages,
    mikrotikParams: req.query,
    momoNumbers: {
      airtel: process.env.MOMO_AIRTEL_NUMBER,
      mtn: process.env.MOMO_MTN_NUMBER,
      zamtel: process.env.MOMO_ZAMTEL_NUMBER
    }
  });
});

// Redeem an existing voucher code (e.g. bought from an attendant / printed voucher)
router.post('/redeem', async (req, res) => {
  const { code, linkLoginOnly } = req.body;
  const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get((code || '').trim().toUpperCase());

  if (!voucher) {
    return res.render('portal/index', {
      packages: db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price ASC').all(),
      mikrotikParams: req.body,
      momoNumbers: {
        airtel: process.env.MOMO_AIRTEL_NUMBER,
        mtn: process.env.MOMO_MTN_NUMBER,
        zamtel: process.env.MOMO_ZAMTEL_NUMBER
      },
      error: 'Voucher code not found.'
    });
  }

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(voucher.package_id);

  if (voucher.status === 'unused') {
    try {
      await mikrotik.createHotspotUser({
        username: voucher.code,
        password: voucher.code,
        limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
        dataCapMb: pkg.data_cap_mb
      });
      db.prepare(`UPDATE vouchers SET status = 'used', used_at = datetime('now') WHERE id = ?`).run(voucher.id);
    } catch (err) {
      return res.render('portal/index', {
        packages: db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price ASC').all(),
        mikrotikParams: req.body,
        momoNumbers: {
          airtel: process.env.MOMO_AIRTEL_NUMBER,
          mtn: process.env.MOMO_MTN_NUMBER,
          zamtel: process.env.MOMO_ZAMTEL_NUMBER
        },
        error: 'Could not activate voucher on the router: ' + err.message
      });
    }
  }

  // Auto-login: submit username/password to MikroTik's hotspot login URL
  res.render('portal/auto-login', {
    username: voucher.code,
    password: voucher.code,
    linkLoginOnly: linkLoginOnly || req.body['link-login-only'] || ''
  });
});

// Customer pays cash to an attendant standing by - attendant enters it directly
// via a shared "cash till" PIN on this same page, or via admin panel.
// Here we just log a pending cash payment for the admin to confirm at the till.
router.post('/pay/cash', (req, res) => {
  const { package_id } = req.body;
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(package_id);
  if (!pkg) return res.status(400).send('Invalid package');
  const info = db.prepare(`INSERT INTO payments (package_id, method, amount, status) VALUES (?, 'cash', ?, 'pending')`)
    .run(package_id, pkg.price);
  res.render('portal/pending', {
    message: `Please pay K${pkg.price} in cash to the attendant. Reference #${info.lastInsertRowid}. Once confirmed, your access code will be issued.`,
  });
});

// Customer sends mobile money then submits the transaction reference here.
router.post('/pay/momo', (req, res) => {
  const { package_id, network, phone, reference } = req.body;
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(package_id);
  if (!pkg) return res.status(400).send('Invalid package');
  db.prepare(`
    INSERT INTO payments (package_id, method, reference, phone, amount, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(package_id, network, reference, phone, pkg.price);
  res.render('portal/pending', {
    message: `Thanks! We received your reference ${reference}. Your access code will be issued shortly after confirmation - check back or ask the attendant.`
  });
});

// Simple polling endpoint the customer's browser can hit to see if their
// mobile money payment got confirmed, and grab their voucher + auto-login.
router.get('/status/:phone/:reference', (req, res) => {
  const payment = db.prepare(`
    SELECT * FROM payments WHERE phone = ? AND reference = ? ORDER BY created_at DESC LIMIT 1
  `).get(req.params.phone, req.params.reference);
  if (!payment) return res.json({ status: 'not_found' });
  res.json({ status: payment.status, voucher_code: payment.voucher_code || null });
});

module.exports = router;
