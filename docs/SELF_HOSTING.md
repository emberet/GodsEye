# Run GodsEye on your own computer, 24/7

GodsEye doesn't need a VPS. Any computer that stays on can be its server: it runs the agent (discovery, analysis, learning, copy trading) and serves the public site at **godseye.work** through a Cloudflare Tunnel, so you don't open ports on your router.

```
 your computer
 ├─ agent      npm run agent:forever   (restarts itself if it crashes)
 ├─ site       npm run site:forever    (production build, http://127.0.0.1:3100)
 └─ cloudflared  ──────────────────────▶  https://godseye.work
```

## 0. What the computer needs

| | |
|---|---|
| RAM | 16 GB recommended (the agent may use up to 8 GB) |
| Disk | 20 GB free; the database grows over time |
| Network | Wired or stable Wi-Fi. Outages pause discovery and copying, which carry on when the connection returns |
| Power | It must **not sleep**. A laptop must stay plugged in, with the lid-close action set to "do nothing" |
| Node.js | 20.10 or newer (https://nodejs.org) |

## 1. Install GodsEye (once)

```bash
git clone https://github.com/emberet/GodsEye.git
cd GodsEye
npm install
npm run setup        # creates .env: add HELIUS_API_KEY at least
npm run status       # checks it starts
```

**Windows:** the npm scripts use Unix shell syntax, so install **Git for Windows** (https://git-scm.com) and point npm at its bash once:

```powershell
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

## 2. Keep the computer awake

| OS | How |
|---|---|
| Windows | Settings → System → Power → *Screen and sleep*: "When plugged in, put my device to sleep after" → **Never**. Laptop: Control Panel → Power Options → *Choose what closing the lid does* → **Do nothing** |
| macOS | System Settings → Energy (or Battery → Options): turn on **Prevent automatic sleeping when the display is off** and **Start up automatically after a power failure** |
| Linux | `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |

The screen may turn off; that's fine.

## 3. Start GodsEye automatically

The agent and the site must start when the computer boots and restart if they crash. `agent:forever` and `site:forever` already restart on a crash; the steps below start them at boot. Replace `/path/to/GodsEye` with your folder.

### Linux (systemd)

Create `/etc/systemd/system/godseye-agent.service`:

```ini
[Unit]
Description=GodsEye agent
After=network-online.target
Wants=network-online.target

[Service]
User=YOUR_USER
WorkingDirectory=/path/to/GodsEye
ExecStart=/usr/bin/env npm run agent -w agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Copy it to `godseye-site.service`, change the description and set `ExecStart=/usr/bin/env sh scripts/run-site.sh`. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now godseye-agent godseye-site
journalctl -u godseye-agent -f        # live log
```

(systemd does the restarting here, so the agent unit calls `npm run agent` directly rather than `agent:forever`. If `npm` isn't found, use the full path from `which npm`.)

### macOS (launchd)

Create `~/Library/LaunchAgents/work.godseye.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>work.godseye.agent</string>
  <key>WorkingDirectory</key><string>/path/to/GodsEye</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>npm run agent -w agent</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/GodsEye/data/agent.log</string>
  <key>StandardErrorPath</key><string>/path/to/GodsEye/data/agent.log</string>
</dict></plist>
```

Make `work.godseye.site.plist` the same way with `sh scripts/run-site.sh` and `data/site.log`. Then:

```bash
launchctl load ~/Library/LaunchAgents/work.godseye.agent.plist
launchctl load ~/Library/LaunchAgents/work.godseye.site.plist
tail -f data/agent.log
```

LaunchAgents start when you log in, so turn on automatic login (System Settings → Users & Groups) if the Mac should come back by itself after a power cut.

### Windows (Task Scheduler)

Open **Task Scheduler** → *Create Task…* (not *Basic Task*):

- **General:** name `GodsEye agent`, select *Run whether user is logged on or not*
- **Triggers:** *At startup*
- **Actions:** Program `C:\Program Files\Git\bin\bash.exe`, arguments `-lc "npm run agent:forever"`, *Start in* `C:\path\to\GodsEye`
- **Conditions:** untick *Start the task only if the computer is on AC power*
- **Settings:** untick *Stop the task if it runs longer than…*

Repeat for `GodsEye site` with `npm run site:forever`. Right-click each task → **Run** to start it now.

## 4. Put the site on godseye.work (Cloudflare Tunnel)

The tunnel connects outwards from your computer to Cloudflare, so you don't need port forwarding, a static IP, or to show your home IP.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared*, name it `godseye`.
2. It shows an install command for your OS (`cloudflared service install <token>`). Run it on this computer; it installs `cloudflared` as a service that starts at boot.
3. **Public hostname:** `godseye.work` → service `HTTP` → `127.0.0.1:3100`.
4. Open https://godseye.work.

If you also deploy the site on Vercel, follow "Host it on Vercel" in the README instead; the agent keeps running here either way.

## 5. Back up what can't be recreated

| File | Why |
|---|---|
| `data/wallet/godseye-keypair.json` | **This file *is* GodsEye's wallet.** Lose it and the SOL in it is gone. Keep a copy offline (USB stick, password manager). |
| `.env` | Your API keys and settings |
| `data/godseye.db` | Wallet history and learning. It can be rebuilt, slowly |

Copy the database safely while the agent runs: `sqlite3 data/godseye.db ".backup data/backup.db"`.

## 6. Day to day

| | |
|---|---|
| Is it alive? | `npm run status` |
| Stop new buys | `npm run pause` (sells and safety exits keep working); `npm run resume` |
| Update GodsEye | `git pull && npm install`, then restart both services (Linux `sudo systemctl restart godseye-agent godseye-site`, macOS `launchctl kickstart -k gui/$(id -u)/work.godseye.agent` and `…site`, Windows end and run the tasks) |

## Security

The hot wallet's key is a file on this computer. Use a computer only you use, with disk encryption on (BitLocker, FileVault, LUKS) and a login password, and fund the wallet only with what you're prepared to lose.
