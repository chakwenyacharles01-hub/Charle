# Deploying NetVend

NetVend now uses MySQL, so it can run cleanly on a cloud host instead of
depending on a local SQLite file. The best fit for the app is a normal Node.js
web service plus a MySQL database.

## Recommended Cloud Host: Railway

Railway is the simplest match for this project because it can:

- deploy the Node/Express app directly from GitHub,
- add a MySQL service to the same project,
- inject MySQL variables such as `MYSQL_URL`, `MYSQLHOST`, `MYSQLUSER`, and
  `MYSQLPASSWORD`,
- give you a public app URL like `https://netvend-production.up.railway.app`.

Important: Railway can host the app and database, but it still needs network
access to the MikroTik RouterOS API. If the router is on a private LAN, use a
WireGuard tunnel or another secure private network path. Do not expose the
RouterOS API openly to the public internet.

## 1. Push to GitHub

Create an empty GitHub repo, then push this project:

```bash
git remote add origin https://github.com/<your-username>/netvend.git
git branch -M main
git push -u origin main
```

If this machine already has GitHub credentials configured, I can run those
commands for you once you give me the repo URL.

## 2. Deploy the App on Railway

1. Go to `https://railway.com/new`.
2. Choose "Deploy from GitHub repo".
3. Select the `netvend` repository.
4. Add a new MySQL database service in the same Railway project.
5. In the NetVend service variables, set:

```bash
SESSION_SECRET=<long-random-value>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<temporary-strong-password>
MIKROTIK_HOST=<router-ip-or-tunnel-ip>
MIKROTIK_USER=billing-api
MIKROTIK_PASSWORD=<router-api-password>
MIKROTIK_PORT=8728
MIKROTIK_USE_TLS=false
MIKROTIK_HOTSPOT_SERVER=hotspot1
MOMO_AIRTEL_NUMBER=0977000000
MOMO_MTN_NUMBER=0966000000
MOMO_ZAMTEL_NUMBER=0955000000
```

Railway should provide `MYSQL_URL` automatically after you add MySQL. If it
does not, set the individual `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`,
`MYSQLPASSWORD`, and `MYSQLDATABASE` variables from the MySQL service.

6. Open Railway's generated domain for the web service.
7. Visit `/admin/login`, sign in, and immediately change the admin password.

## 3. MikroTik Connectivity from the Cloud

For a real deployment, the cloud app must reach the router. The secure pattern
is:

- assign the router or an on-site device a WireGuard address, e.g.
  `10.10.10.1`,
- connect the cloud host/VPS to that WireGuard network,
- set `MIKROTIK_HOST=10.10.10.1`.

Railway is easiest for the app and MySQL. If you need full control over
WireGuard on the host itself, use a small VPS with Docker Compose instead.

## 4. VPS/Docker Alternative

On an Ubuntu VPS:

```bash
git clone https://github.com/<your-username>/netvend.git
cd netvend
cp .env.example .env
nano .env
docker compose up -d --build
```

The included `docker-compose.yml` starts both NetVend and MySQL 8.4, with
database data stored in the `mysql-data` Docker volume.

For HTTPS, put Caddy or another reverse proxy in front of port `3000`.
