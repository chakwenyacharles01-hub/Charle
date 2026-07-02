const express = require('express');
const db = require('../config/db');
const mikrotik = require('../config/mikrotik');
const { generateCode, minutesToRouterosUptime } = require('../utils/voucherGen');

const router = express.Router();

async function renderPortal(res, { params = {}, error } = {}) {
  const packages = await db.all('SELECT * FROM packages WHERE active = 1 ORDER BY price ASC');
  return res.render('portal/index', {
    packages,
    mikrotikParams: params,
    momoNumbers: {
      airtel: process.env.MOMO_AIRTEL_NUMBER,
      mtn: process.env.MOMO_MTN_NUMBER,
      zamtel: process.env.MOMO_ZAMTEL_NUMBER
    },
    error
  });
}

// The MikroTik hotspot redirects unauthenticated clients here.
// It passes along params like ?mac=...&ip=...&link-login=... which we
// forward through so we can auto-submit the login form after purchase.
router.get('/', async (req, res, next) => {
  try {
    await renderPortal(res, { params: req.query });
  } catch (err) {
    next(err);
  }
});

// Redeem an existing voucher code (e.g. bought from an attendant / printed voucher)
router.post('/redeem', async (req, res, next) => {
  const { code, linkLoginOnly } = req.body;
  try {
    const voucher = await db.get('SELECT * FROM vouchers WHERE code = ?', [(code || '').trim().toUpperCase()]);

    if (!voucher) {
      return renderPortal(res, { params: req.body, error: 'Voucher code not found.' });
    }

    const pkg = await db.get('SELECT * FROM packages WHERE id = ?', [voucher.package_id]);

    if (voucher.status === 'unused') {
      await mikrotik.createHotspotUser({
        username: voucher.code,
        password: voucher.code,
        limitUptime: minutesToRouterosUptime(pkg.duration_minutes),
        dataCapMb: pkg.data_cap_mb
      });
      await db.run(`UPDATE vouchers SET status = 'used', used_at = NOW() WHERE id = ?`, [voucher.id]);
    }

    // Auto-login: submit username/password to MikroTik's hotspot login URL
    res.render('portal/auto-login', {
      username: voucher.code,
      password: voucher.code,
      linkLoginOnly: linkLoginOnly || req.body['link-login-only'] || ''
    });
  } catch (err) {
    if (err.message) {
      return renderPortal(res, {
        params: req.body,
        error: 'Could not activate voucher on the router: ' + err.message
      });
    }
    next(err);
  }
});

// Customer pays cash to an attendant standing by - attendant enters it directly
// via a shared "cash till" PIN on this same page, or via admin panel.
// Here we just log a pending cash payment for the admin to confirm at the till.
router.post('/pay/cash', async (req, res, next) => {
  const { package_id } = req.body;
  try {
    const pkg = await db.get('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!pkg) return res.status(400).send('Invalid package');
    const info = await db.run(`INSERT INTO payments (package_id, method, amount, status) VALUES (?, 'cash', ?, 'pending')`, [package_id, pkg.price]);
    res.render('portal/pending', {
      message: `Please pay K${pkg.price} in cash to the attendant. Reference #${info.lastInsertRowid}. Once confirmed, your access code will be issued.`,
    });
  } catch (err) {
    next(err);
  }
});

// Customer sends mobile money then submits the transaction reference here.
router.post('/pay/momo', async (req, res, next) => {
  const { package_id, network, phone, reference } = req.body;
  try {
    const pkg = await db.get('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!pkg) return res.status(400).send('Invalid package');
    await db.run(`
      INSERT INTO payments (package_id, method, reference, phone, amount, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `, [package_id, network, reference, phone, pkg.price]);
    res.render('portal/pending', {
      message: `Thanks! We received your reference ${reference}. Your access code will be issued shortly after confirmation - check back or ask the attendant.`
    });
  } catch (err) {
    next(err);
  }
});

// Simple polling endpoint the customer's browser can hit to see if their
// mobile money payment got confirmed, and grab their voucher + auto-login.
router.get('/status/:phone/:reference', async (req, res, next) => {
  try {
    const payment = await db.get(`
    SELECT * FROM payments WHERE phone = ? AND reference = ? ORDER BY created_at DESC LIMIT 1
    `, [req.params.phone, req.params.reference]);
    if (!payment) return res.json({ status: 'not_found' });
    res.json({ status: payment.status, voucher_code: payment.voucher_code || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
