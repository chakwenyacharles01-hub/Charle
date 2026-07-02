# NetVend — Smart WiFi Billing Solution (MikroTik hAP lite edition)

A self-hosted WiFi hotspot billing app: sell time-based access packages,
generate printable vouchers, accept cash or mobile money, and automatically
create/activate hotspot users on your MikroTik hAP lite via the RouterOS API.

## What you get
- Admin dashboard: revenue, active sessions, voucher stats
- Packages: define speed, duration, data cap, price
- Vouchers: bulk-generate printable codes
- Payments queue: confirm cash / mobile money (Airtel, MTN, Zamtel) payments
- Customer captive portal: buy a package or redeem a voucher, auto-connects
  them to the router on success
- Everything talks to the hAP lite over the RouterOS API - no manual user
  creation needed

> **Deploying this?** See [`README-DEPLOY.md`](./README-DEPLOY.md) for pushing
> to GitHub, hosting the marketing page on Netlify/Vercel for free, and
> running the real app on a VPS or Raspberry Pi.

## Recommended hardware
Run this app on a small always-on device on the **same LAN** as the router -
a Raspberry Pi 4/5, an old laptop, or a cheap mini PC. Don't expose the
RouterOS API to the public internet.

---

## Part 1: Configure the MikroTik hAP lite

Connect to the router with Winbox or WebFig.

### 1. Enable the API service
`IP → Services` → make sure `api` is enabled (port 8728). For better security,
disable `api` and enable `api-ssl` instead (port 8729), then set
`MIKROTIK_USE_TLS=true` in `.env`.

### 2. Create a dedicated API user (don't use your main admin account)
`System → Users → Groups` - create a group called `billing-api-group` with at
least these permissions: `api`, `read`, `write`, `test`.

`System → Users` - create a user `billing-api` in that group, with a strong
password. Put these in your `.env` file.

### 3. Set up the Hotspot
Use the Hotspot Setup wizard: `IP → Hotspot → Hotspot Setup`
- Hotspot interface: your WiFi interface (e.g. `wlan1` or the bridge it's on)
- Address pool: let it create one (e.g. `10.5.50.2-10.5.50.254`)
- SSL certificate: none (unless you have one)
- SMTP server: leave blank
- DNS name: leave blank or set something like `wifi.local`
- Name of local hotspot user: skip / delete the default `admin`/test user it
  creates - our app manages users itself

Note the **hotspot server profile name** it creates (usually `hotspot1`) -
put that in `MIKROTIK_HOTSPOT_SERVER` in `.env`.

### 4. Point the hotspot's login page at this app
`IP → Hotspot → Server Profiles → hotspot1 → Login` tab: this controls the
built-in `login.html`. The simplest approach:

**Option A (recommended, easiest): Walled Garden redirect**
Leave the router's default login page as-is, but add a Walled Garden entry so
unauthenticated users can reach your app, then edit the router's
`login.html` (via Files → hotspot folder) to redirect straight to your app:

`IP → Hotspot → Walled Garden` → add an entry allowing HTTP to the IP of the
device running this app (e.g. `192.168.88.50`) on port `3000`.

Then edit `hotspot/login.html` on the router and replace its `<body>`
contents with a simple redirect that preserves MikroTik's login variables:

```html
<script>
  window.location = "http://192.168.88.50:3000/portal?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)";
</script>
```

This way, when a customer connects to your WiFi, MikroTik shows this
redirect, which bounces them to your app's `/portal` page, carrying the
special `$(link-login-only)` URL your app needs to actually log them in
after payment.

**Option B: Skip the redirect, host everything on the router's hotspot page**
More advanced - not covered here, but Option A is simpler and works well for
one site.

### 5. Test connectivity
Once the app is running, go to its admin panel → **Router** tab and confirm
it can see the router's identity.

---

## Part 2: Install and run the app

Requires Node.js 18+ and MySQL 8+.

```bash
cd wifi-billing
npm install
cp .env.example .env
# edit .env with your MySQL credentials, router IP, API user/password, admin login, momo numbers
npm start
```

The app starts on port 3000 by default:
- Admin panel: `http://<device-ip>:3000/admin/login` (default admin/changeme123 -
  change this immediately after first login)
- Customer portal: `http://<device-ip>:3000/portal`

To keep it running permanently on a Raspberry Pi, use `pm2`:
```bash
npm install -g pm2
pm2 start src/server.js --name wifi-billing
pm2 save
pm2 startup
```

---

## Part 3: Mobile money payments

Real-time API integration with Airtel Money / MTN MoMo / Zamtel Kwacha in
Zambia requires a registered merchant/collections account with each
provider, which takes time to set up. To get you running immediately, this
app uses a **manual confirmation flow** that works with just a personal or
agent mobile money number:

1. Customer picks a package and mobile money network on the portal
2. The portal shows your number and asks them to send the exact amount
3. Customer enters their phone + the SMS transaction reference back into the
   portal
4. You (the admin) see it appear in the **Payments** queue, cross-check it
   against the SMS you receive on your phone, and click **Confirm**
5. The app auto-generates a voucher and creates the user on the router

This is exactly how most small hotspot/tuckshop operators run mobile money
today. If you later get merchant API access from Airtel/MTN, you can wire
their webhook into `src/routes/portalRoutes.js` (`/pay/momo`) to
auto-confirm instead of waiting on the admin.

---

## How the billing flow works end to end

1. Customer connects to your WiFi SSID
2. MikroTik hotspot intercepts their traffic and redirects to your portal
3. Customer buys a package (cash/momo) or enters an existing voucher code
4. On confirmation, the app calls the RouterOS API to create a hotspot user
   with a time limit (`limit-uptime`) and optional data cap
   (`limit-bytes-total`)
5. The app auto-submits the login form to MikroTik's `$(link-login-only)`
   URL, so the customer is instantly online - no manual typing needed
6. When their time/data runs out, MikroTik automatically disconnects them
   (this is native RouterOS hotspot behavior - no extra code needed)

## Selling printed vouchers (no internet needed at point of sale)
Go to **Vouchers**, generate a batch tied to a package, and print/write them
out. A customer can redeem any unused code directly on the portal page (the
"Already have a voucher code?" box) - it gets activated on the router at the
moment of redemption, not when it was printed, so unsold vouchers don't
expire from sitting on a shelf.

## Notes & things to customize
- Speed formats (`download_speed`/`upload_speed`) follow MikroTik's
  rate-limit syntax, e.g. `5M`, `512k`.
- NetVend stores billing data in MySQL. Back up the MySQL database
  periodically, especially vouchers and payments.
- Change `SESSION_SECRET` and both default passwords before going live.
- This app assumes one router. Scaling to multiple sites would mean adding a
  `location`/`router_id` column throughout and picking the right MikroTik
  connection per request - ask if you get there and want that built out.
