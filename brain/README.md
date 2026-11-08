# GodsEye Brain (Mac side)

The brain is the reinforcement-learning copy policy behind the **paper** Brain / Explore accounts, plus a private social
model. It trains on the owner's Mac and ships ONNX bundles to the server; the TypeScript runtime (`agent/src/brain/`)
only loads them. The two sides meet through [`spec/CONTRACT.md`](spec/CONTRACT.md). Paper money only: nothing here
touches the real copy engine, a wallet or a transaction.

## Setup (once)

```bash
conda env create -f brain/environment.yml              # the godseye-brain env: python 3.12, torch (MPS), duckdb, ...
conda run -n godseye-brain pip install -e 'brain[dev]'   # the brain package, editable, plus pytest
conda run -n godseye-brain python -m pytest -q brain/tests
```

`environment.yml` pins every version; after changing it, `conda env update -f brain/environment.yml --prune`. The
scripts find the env at `~/miniconda3/envs/godseye-brain` (override with `BRAIN_ENV=<env dir>`).

The Mac reaches the server through the ssh alias `GodsEye` (key-based login in `~/.ssh/config`; the scripts use
`BatchMode`, so a password prompt fails instead of hanging).

## Where data lives

Everything goes to `BRAIN_DATA_DIR` (default `~/GodsEyeBrainData`), outside the repo. On the owner's Mac that is a
symlink to `/Volumes/HP -E1/GodsEyeBrainData` on the external drive. Nothing data-like (Parquet, ONNX, reports) is ever
written into the repo.

| folder         | what                                                                         |
|----------------|------------------------------------------------------------------------------|
| `export/`      | server tables as Parquet (pulled incrementally)                              |
| `archive_raw/` | the server's swap archive as rsynced (daily ndjson.gz), converted into `export/` |
| `derived/`     | episodes, episode paths, 1-minute bars, insert-time steps, hourly swap counts and the masked ingest-outage hours, built from the swaps |
| `sim/`         | the simulator's fitted inputs: `ledger_mirror.parquet` (brain.sim.ledger), `quote_model.json` (brain.sim.quotes) |
| `private/`     | social (X) tables and the social model: never published                      |
| `models/`      | trained bundles, one folder per version                                      |
| `research/`    | outputs of the scripts in `research/<topic>/`                                 |
| `reports/`     | gate and research reports (the research report: `research-2026-11-06.html`)  |
| `logs/`        | `cycle-YYYY-MM-DD.log`, `launchd.log`                                        |
| `tmp/`         | temp files of the cycle and duckdb (kept off the Mac's own disk)             |

The drive is FAT32: no symlinks on it, no file of 4 GB or more, and macOS writes `._*` twins next to files, so globs
are `'[!.]*.parquet'`. The path has a space: quote it. Load data through `brain.data.connect()` (duckdb views over
everything above).

On the server, bundles land in `/opt/godseye/app/data/brain/`: `models/<version>/`, `current` (the live one),
`previous` (for rollback) and `staging/` (uploads in flight). The social model gets the same layout under `social/`,
plus `social/manifest.json` and `social/social.onnx` (the paths the runtime reads) linked through `social/current`.
Override with `BRAIN_SERVER`, `BRAIN_SERVER_DIR`, `BRAIN_SERVER_DB`.

## Run a cycle by hand

The whole cycle, exactly as launchd runs it (it logs to the day's cycle log, not the terminal):

```bash
brain/scripts/cycle.sh                       # hourly mode; a full retrain when run in the 03:xx hour
CYCLE_MODE=full brain/scripts/cycle.sh       # force a full retrain
CYCLE_EXPLORE_ONLY=0 brain/scripts/cycle.sh  # don't push a gate-3 bundle explore-only (it is pushed by default)
```

Or one step at a time, in the env (`conda activate godseye-brain`, from `brain/`):

```bash
scripts/pull.sh                                    # server data -> export/ (refuses if the drive is unplugged)
python -m brain.train --mode hourly                # fine-tune; --mode full retrains from scratch
python -m brain.gate --bundle <bundle dir> --no-test  # 0 = promote, 3 = explore-only, else keep the server's
python -m brain.push <bundle dir> --check          # validate only
python -m brain.push <bundle dir>                  # gate 0: validate, scp, verify on the server, switch `current`
python -m brain.push <bundle dir> --explore-only   # gate 3: the same, shipped with brain_enabled false
python -m brain.social.train                       # the private social model
python -m brain.gate --bundle <dir> --social && python -m brain.push <dir> --social
```

The cycle always gates with `--no-test`: the TEST window (11-02 onward, `spec/splits.yaml`) is scored once, by hand,
at the end, never hour by hour. Leave the flag off only for that one final run.

What the gate's exit means (CONTRACT.md "Promotion"):

- **0, promote:** the bundle beats the B4 hand-rule baseline on the selection window (and the rest of the bar). It is
  pushed as is and the Brain account trades it on paper.
- **3, explore-only:** it passes the sanity and stress checks but not the bar. `--explore-only` ships it with
  `brain_enabled: false` (only the manifest changes; it isn't in `sha256`), so the Brain account skips every signal and
  the Explore account keeps gathering data. It is pushed only while the server has no promoted model: push reads the
  server's `current/manifest.json` first and the install script checks again before switching. When the live model
  is promoted (`brain_enabled` true, or a manifest without the flag), it exits 4 and nothing changes. The runtime
  (`agent/src/brain/model.ts`, `policy.ts`) reads the flag and reloads when the manifest changes. The cycle pushes
  exit 3 by default; `CYCLE_EXPLORE_ONLY=0` makes it keep the server's model instead.
- **anything else:** the server keeps its current model. The social lane has no explore-only: only 0 pushes it.

`brain.push` refuses (exit 2) a bundle without `manifest.json`, with an unsafe version or file name, or with any file
missing or not matching its `sha256`. The server checks every hash again before it switches `current` (a temp symlink
renamed over the old one, so the runtime never sees a half-written model). It keeps `previous` and the newest 5
versions. A version already on the server is reused when its networks match, and only a different `manifest.json` is
replaced, so a version pushed explore-only can later be pushed again as promoted. Roll back on the server: `cd /opt/godseye/app/data/brain && ln -sfn "$(readlink previous)" current.tmp && mv -Tf current.tmp current`.

## Every hour (launchd)

```bash
BRAIN_DATA_DIR="$HOME/GodsEyeBrainData" brain/scripts/install-launchd.sh
launchctl kickstart gui/$(id -u)/work.godseye.brain     # run one cycle now
launchctl print gui/$(id -u)/work.godseye.brain | grep -E 'state|last exit'
```

Run the installer again after moving the repo or the data dir. Remove:
`launchctl bootout gui/$(id -u)/work.godseye.brain && rm ~/Library/LaunchAgents/work.godseye.brain.plist`.

`scripts/cycle.sh` runs pull, train (a full retrain in the 03:00 cycle), gate and push as above; then the same for the
social model. It exits quietly, writing nothing, when the data dir itself isn't there (`-d` on `BRAIN_DATA_DIR`: an
unplugged drive, or the Mac just woke), never overlaps another cycle (a lock in the data dir; a crashed cycle's lock is
taken over) and skips, with a log line, any step whose module isn't built yet. If the pull fails, the cycle stops and
nothing is pushed. A missed hour runs once when the Mac wakes.

## Reading the logs

```bash
tail -f "$HOME/GodsEyeBrainData/logs/cycle-$(date +%Y-%m-%d).log"
grep -h 'cycle end' ~/GodsEyeBrainData/logs/cycle-*.log | tail          # how recent cycles ended
grep -hE 'gate exit|push' ~/GodsEyeBrainData/logs/cycle-*.log | tail     # what was pushed, and why not
```

Every line starts with a local timestamp. Each step logs `<step>: start` and `<step>: exit <code> (<seconds>s)`, with
the step's own output in between. The lines worth knowing:

| line                                                       | meaning                                                   |
|------------------------------------------------------------|-----------------------------------------------------------|
| `cycle start (pid …, mode hourly\|full)`                    | a cycle began                                             |
| `cycle end (ok)` / `cycle end (with failures)`             | it finished; a failure is a train or push step that broke |
| `cycle end: pull failed`                                   | the server couldn't be reached: nothing trained or pushed |
| `model: new bundle <dir>`                                  | train wrote this bundle                                   |
| `model: gate exit 3: explore-only, not pushed …`           | `CYCLE_EXPLORE_ONLY=0`: the server keeps its model        |
| `model: gate exit 3: explore-only (brain_enabled false) …` | pushing it with `brain_enabled: false`                    |
| `model: the server runs a promoted model: it keeps it`     | the explore-only push was skipped (push exit 4)           |
| `model: gate exit N: the server keeps its current model`   | not promoted, nothing pushed                              |
| `<module> isn't built yet: skipped`                        | that step's code hasn't landed                            |
| `cycle <pid> still running: skipped`                       | the previous cycle is still going                         |
| `stale lock (pid …): taking it over`                       | a crashed cycle left its lock                             |

No cycle log at all for an hour usually means the drive wasn't mounted. `logs/launchd.log` holds what launchd itself
reports (e.g. bash not starting); it is on the drive too, so it is empty while the drive is away. If the drive is
mounted and a `launchctl kickstart` still writes no log, macOS is probably keeping launchd's `/bin/bash` off the
external drive: allow it under System Settings → Privacy & Security (Full Disk Access, or Files and Folders →
Removable Volumes), then kickstart again.

## Research record

`research/DATA.md` describes the data and its traps. Each `research/<topic>/` holds that topic's scripts and a
`findings.md`: the summary, every claim with its number, sample size, script and the verifier's verdict (refuted ones
marked), the recommended features and the caveats. The specs in `spec/` are built from them; `spec/splits.yaml` is the
one definition of the fit / selection / test windows (the test window is used once, at the end, never for tuning). The full report is
`reports/research-2026-11-06.html` on the drive (private).

## Server: restart on a new key

`agent/deploy/godseye-env-watch.{path,service}` restart `ge-ingest` and the agent when `/etc/godseye/ingest.env` or
`/opt/godseye/app/.env` is saved, so pasting a renewed Shyft gRPC URL/token (or the X token) is all it takes.
A restart keeps `data/`. Install: copy both to `/etc/systemd/system/`, `systemctl daemon-reload`,
`systemctl enable --now godseye-env-watch.path`.

## Privacy of the social model

The social model and its data are private. They stay in `private/` on the Mac and `data/brain/social/` on the server,
and never appear on the site, the API, the snapshot or the published logs. Don't copy `private/` anywhere else, and
don't paste social reports into issues or commits.
