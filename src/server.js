require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');

const adminRoutes = require('./routes/adminRoutes');
const portalRoutes = require('./routes/portalRoutes');
const db = require('./config/db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'insecure_dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4 } // 4 hour admin session
}));

app.use('/admin', adminRoutes);
app.use('/portal', portalRoutes);

// Root just forwards to the customer portal (this is what the MikroTik
// hotspot "html-directory" login page can redirect to, or you can point
// the hotspot's login page directly at /portal).
app.get('/', (req, res) => res.redirect('/portal'));

// Housekeeping: mark old pending payments as rejected after 30 min so they
// don't clutter the admin queue forever.
cron.schedule('*/10 * * * *', () => {
  db.run(`
    UPDATE payments SET status = 'rejected'
    WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
  `).catch((err) => {
    console.error('Payment housekeeping failed:', err);
  });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await db.initDb();

  app.listen(PORT, () => {
    console.log(`WiFi billing app running on http://0.0.0.0:${PORT}`);
    console.log(`Admin panel: http://<this-device-ip>:${PORT}/admin/login`);
    console.log(`Customer portal: http://<this-device-ip>:${PORT}/portal`);
  });
}

start().catch((err) => {
  console.error('Failed to start NetVend:', err);
  process.exit(1);
});
