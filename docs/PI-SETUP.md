# Raspberry Pi 5 setup: retail-inventory-billing

**Audience:** Claude Code running on the Pi (via Remote Control), working for the shop owner.
**Goal:** run the app 24/7 on this Pi, reachable privately from the owner's phone over **Tailscale** with HTTPS (so the camera barcode scanner works), with nightly backups.

## Rules for you (Claude)
- Work step by step. After each step, run its **Check** and report the result before moving on.
- Ask the owner before anything destructive or irreversible: deleting `data/`, `db:seed --reset`, `rm -rf`, changing SSH/firewall settings, or reformatting anything.
- **Never expose the app to the public internet.** Do not use `tailscale funnel`, do not suggest router port-forwarding. Tailscale `serve` only (private to the owner's tailnet).
- Do not print or store secrets (Tailscale auth keys, passwords) in files or the repo.
- The real shop data lives in `data/app.db`. Never run `npm run db:seed` on a Pi that already has real data. Seed only on a fresh install if the owner wants sample data.
- Use the repo branch `ccr-ecf44a9e-yxvj6m` unless the owner says otherwise (it is not merged to main yet).
- If a step fails, show the exact error and stop. Don't guess-and-retry in loops.

## 0. Prerequisites (confirm with the owner)
- Raspberry Pi 5 with **Raspberry Pi OS 64-bit** (check: `uname -m` prints `aarch64`).
- Internet access on the Pi, and the owner has a free Tailscale account and the Tailscale app on their phone.
- Check: `uname -m`, `cat /etc/os-release | head -3`, `df -h /` (need > 2 GB free), `free -h`.

## 1. System update and base tools
```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git build-essential python3 sqlite3 curl
```
Check: `git --version && sqlite3 --version`

## 2. Node.js 22
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```
Check: `node -v` prints `v22.x` and `npm -v` works.

## 3. Get the app
```bash
cd ~
git clone https://github.com/rakeshv0498/retail-inventory-billing.git
cd retail-inventory-billing
git checkout ccr-ecf44a9e-yxvj6m
npm ci
```
Check: `npm ci` ends without errors. Then verify the native SQLite module loads on this CPU:
```bash
node -e "const D=require('better-sqlite3');console.log(new D(':memory:').prepare('select sqlite_version() v').get())"
```
If that fails, run `npm rebuild better-sqlite3 --build-from-source` (needs `build-essential`, `python3`) and re-check.

## 4. Create the database and build
```bash
npm run db:push        # creates data/app.db (safe to re-run; it only syncs the schema)
npm run build
```
Ask the owner: *"Do you want sample data (demo products) or a clean empty database for real use?"*
- Sample data (fresh install only): `npm run db:seed`
- Clean: do nothing. The owner adds products in the app.

Check: `ls -la data/app.db` exists; `npm run build` finishes with a route table.

## 5. Run as a service (auto-start on boot)
Find the Linux username with `whoami` and use it for `<user>` below.
```bash
sudo tee /etc/systemd/system/retail-billing.service >/dev/null <<'EOF'
[Unit]
Description=Retail inventory & billing
After=network-online.target
Wants=network-online.target

[Service]
User=<user>
WorkingDirectory=/home/<user>/retail-inventory-billing
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo sed -i "s/<user>/$(whoami)/g" /etc/systemd/system/retail-billing.service
sudo systemctl daemon-reload
sudo systemctl enable --now retail-billing
```
Check: `systemctl is-active retail-billing` prints `active`, and `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/` prints `200`. Logs: `journalctl -u retail-billing -n 50 --no-pager`.

## 6. Tailscale (private access + HTTPS)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```
`tailscale up` prints a login URL. **Ask the owner to open it and sign in**, then continue. (`--ssh` lets the owner SSH in over Tailscale from their phone with no keys.)

Then enable HTTPS for the app, private to the tailnet:
```bash
sudo tailscale serve --bg 3000
tailscale serve status
```
The status output shows the URL, like `https://<pi-name>.<tailnet>.ts.net`. If it says HTTPS is not enabled for the tailnet, tell the owner to turn on **HTTPS Certificates** in the Tailscale admin console (DNS page), then re-run `sudo tailscale serve --bg 3000`.

Check: from the owner's phone (Tailscale app connected), open that `https://…ts.net` URL. The app loads, and the 📷 scan button in POS opens the camera. Give the owner this URL and tell them to use **Add to Home Screen**.

Security check: `sudo tailscale funnel status` must show nothing is exposed publicly.

## 7. Backups (nightly)
```bash
mkdir -p ~/backups
( crontab -l 2>/dev/null; echo '0 23 * * * sqlite3 $HOME/retail-inventory-billing/data/app.db ".backup $HOME/backups/app-$(date +\%F).db" && find $HOME/backups -name "app-*.db" -mtime +30 -delete' ) | crontab -
```
Check: `crontab -l` shows the line. Test it once now:
```bash
sqlite3 ~/retail-inventory-billing/data/app.db ".backup $HOME/backups/app-test.db" && ls -la ~/backups
```
Remind the owner to copy `~/backups` off the Pi occasionally (USB stick or PC). A backup on the same SD card does not survive card failure.

## 8. Updating later
```bash
cd ~/retail-inventory-billing
cp data/app.db ~/backups/app-before-update-$(date +%F-%H%M).db
git pull
npm ci && npm run build && npm run db:push
sudo systemctl restart retail-billing
```
Check: `systemctl is-active retail-billing` is `active` and the app loads.
If the update breaks things: `git log --oneline -5`, `git checkout <previous-commit>`, rebuild, restart, and restore the backup if the data was affected (ask first).

## 9. Final report to the owner
Summarize in a short list: Node version, app commit (`git rev-parse --short HEAD`), service status, the private HTTPS URL, backup schedule, and anything skipped or failing.

## Notes
- **No login in the app yet.** Access is limited to devices on the owner's Tailscale network, which is the protection. The owner can ask for an optional PIN screen to be built later (a separate task, not part of this setup). Anyone on the owner's tailnet (or the shop Wi-Fi if the owner opens `http://<pi-ip>:3000`) can use the app.
- To restrict to Tailscale only, the owner can later block port 3000 on the LAN: `sudo apt install -y ufw && sudo ufw allow in on tailscale0 && sudo ufw allow ssh && sudo ufw deny 3000 && sudo ufw enable`. **Ask first**: a wrong firewall rule can lock out SSH.
- Power: use the official 27W supply. An SSD is more reliable than a microSD card for the database.
