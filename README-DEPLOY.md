# Deploying NetVend

This covers three separate things, because they're genuinely different jobs:

1. **Push the code to GitHub** (5 minutes)
2. **Put the marketing/demo page online for free** (Netlify or Vercel — 5 minutes)
3. **Run the real billing app somewhere it can reach your router** (VPS or Raspberry Pi — 20-30 minutes)

Read the note below before picking an option for #3 — it matters.

---

## Why the real app can't just go on Netlify/Vercel/Firebase

Those platforms run your code in a serverless sandbox with **no access to your
private LAN** (192.168.88.0/24 where your hAP lite lives). NetVend's core job
is talking directly to the router's API, so it must run either:

- **On the same network as the router** (a Raspberry Pi at the premises — simplest, most reliable), or
- **On a VPS, connected back to the router over an encrypted tunnel** (WireGuard) — works, but is more moving parts

Netlify/Vercel/Firebase are genuinely great for the **static marketing/demo
page** you already have (`netvend_demo.html`) — that one has no backend
dependency, so it deploys perfectly there.

---

## Part 1 — Push to GitHub

I've already initialized a git repo in this project with an initial commit.
You just need to create an empty repo on GitHub and push:

```bash
cd netvend
# create a new repo at https://github.com/new (don't initialize it with a README)
git remote add origin https://github.com/<your-username>/netvend.git
git branch -M main
git push -u origin main
```

That's it — your code is on GitHub.

---

## Part 2 — Marketing/demo page: Netlify or Vercel (free)

**Netlify (drag-and-drop, fastest):**
1. Go to https://app.netlify.com/drop
2. Drag `netvend_demo.html` (rename it to `index.html` first) into the browser window
3. You get a live public URL immediately — no account required to try it, free account to keep it permanently

**Netlify (connected to GitHub, auto-deploys on push):**
1. Put `netvend_demo.html` (renamed `index.html`) into a `/marketing` folder in your repo and push it
2. On https://app.netlify.com → "Add new site" → "Import an existing project" → pick your GitHub repo
3. Set "Publish directory" to `marketing`
4. Deploy — every future `git push` auto-updates the live site

**Vercel (same idea):**
1. https://vercel.com/new → import your GitHub repo
2. Framework preset: "Other" (it's a static HTML file)
3. Output directory: `marketing`
4. Deploy

Either gives you a free `*.netlify.app` or `*.vercel.app` URL immediately, and
you can attach a custom domain (e.g. `netvend.co.zm`) for free on both once
you own one.

---

## Part 3 — The real billing app

### Option A: Raspberry Pi on-site (recommended for a single location)
This is what the main `README.md` already walks through — simplest and most
reliable since the app sits on the same LAN as the router. No tunnel needed.

### Option B: VPS + WireGuard tunnel back to the router
Use this if you want the app hosted off-site (e.g. so you can manage several
locations from one server later, or you don't want any hardware on-site
beyond the router).

**1. Get a VPS.** Any $4-6/mo VPS works (DigitalOcean, Hetzner, Contabo,
Vultr). Ubuntu 22.04 or 24.04 image.

**2. Install Docker on the VPS:**
```bash
curl -fsSL https://get.docker.com | sh
```

**3. Set up the WireGuard tunnel.** You need a WireGuard endpoint *at the
router's location* for the VPS to connect to. The simplest way: run
WireGuard directly on the MikroTik itself (RouterOS v7+ has native
WireGuard support):

```
# On the hAP lite (in Winbox terminal):
/interface wireguard add name=wg-netvend listen-port=13231
/interface wireguard print   # note the generated public key

/ip address add address=10.10.10.1/24 interface=wg-netvend

/interface wireguard peers add interface=wg-netvend \
  public-key="<VPS's public key - generate this on the VPS first>" \
  allowed-address=10.10.10.2/32 endpoint-address=<your VPS public IP> \
  endpoint-port=13231
```

On the VPS, install WireGuard (`apt install wireguard`), generate a keypair
(`wg genkey | tee privatekey | wg pubkey > publickey`), and configure a peer
pointing back at the router's public IP (or use the MikroTik as the
"server" side if your VPS has a static IP and the router doesn't — either
direction works, VPS-as-client is usually easier since VPS IPs are stable).

**4. Point NetVend at the tunnel IP.** In `.env`, set:
```
MIKROTIK_HOST=10.10.10.1
```
(the router's WireGuard tunnel address, not its LAN IP)

**5. Deploy NetVend with Docker:**
```bash
git clone https://github.com/<your-username>/netvend.git
cd netvend
cp .env.example .env
nano .env   # fill in your real values
docker compose up -d --build
```

**6. Put HTTPS + a domain in front of it (recommended)** using Caddy — it
handles free Let's Encrypt certificates automatically:
```bash
sudo apt install -y caddy
```
`/etc/caddy/Caddyfile`:
```
billing.yourdomain.com {
    reverse_proxy localhost:3000
}
```
```bash
sudo systemctl reload caddy
```

Now `https://billing.yourdomain.com` is your live admin panel + customer
portal, backed by a VPS, securely tunneled to your actual hAP lite.

### Which should you pick?
- **One site, want it simple and cheap:** Raspberry Pi on-site. No tunnel, no VPS bill, nothing to go wrong on the network path.
- **Want it "in the cloud", might add more sites later, comfortable with a bit more setup:** VPS + WireGuard.

If you tell me which one you want to actually run with, I can walk through that specific path with you step by step as you go.
