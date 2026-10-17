# calmirror

Keep several Google Calendars honest about each other — without leaking details.

calmirror is a small set of Node.js scripts (no dependencies) that run on a timer and:

1. **Mirror busy blocks** across any number of Google calendars (personal, work, side projects, a shared family calendar…). Every busy event in one calendar shows up in the others as a private `Busy — <Label>` block with no title, attendees or location. Overlapping events are merged into one block; invitations already present in a calendar are not duplicated; declined, free/transparent and cancelled events are ignored. Blocks are updated and removed as the originals change.
2. **Work Mode** (optional): a recurring `💻 Work Mode` block in your personal calendar covers your working hours, so individual work meetings inside it are *not* mirrored there (keeps the personal calendar clean). Each day the block is stretched automatically when a real work event starts earlier or ends later. Optional 15-minute `work_start` / `work_end` markers in a work calendar follow the same window.
3. **Commute blocks**: events with a physical location get traffic-aware travel blocks before and after them, computed with the [Google Routes API](https://developers.google.com/maps/documentation/routes). Appointments close together are chained (A → B instead of A → home → B). Route results are cached in the event and refreshed more often as departure approaches. These blocks are then mirrored as plain busy time by step 1.

Everything calmirror creates is tagged with private extended properties (`calmirror_*`), so it never mirrors its own output and can safely reconcile/delete it.

## Requirements

- Node.js 18+ (uses global `fetch`)
- [`gog`](https://github.com/steipete/gogcli) — Google CLI used for all Calendar API access, authenticated for each account you list
- A Google Cloud API key with the Routes API enabled (only for commute blocks)
- Linux with systemd user units (or any scheduler: cron, launchd…)

## Setup

```sh
git clone https://github.com/<owner>/calmirror ~/calmirror
mkdir -p ~/.config/calmirror && chmod 700 ~/.config/calmirror
cp ~/calmirror/config.example.json ~/.config/calmirror/config.json
$EDITOR ~/.config/calmirror/config.json
```

### 1. Authenticate gog

Authorize every account in the config with Calendar scope (see gog's docs, e.g. `gog auth add you@example.com`). For unattended runs use a file keyring; `bin/calmirror-gog.example` is a wrapper template that points gog at a dedicated home and reads the keyring password from a `chmod 600` file:

```sh
cp ~/calmirror/bin/calmirror-gog.example ~/.local/bin/calmirror-gog
chmod 700 ~/.local/bin/calmirror-gog
```

Set `"gog"` in the config (or `CALMIRROR_GOG`) to the wrapper path.

### 2. Configure

| Key | Meaning |
| --- | --- |
| `timezone` | IANA zone used for Work Mode hours and day boundaries |
| `accounts[]` | `alias`, `label` (shown in busy blocks), `account` (gog account email), optional `calendarId` (default `primary`), `colorId` |
| `accounts[].destination: false` | read-only source: mirrored *from*, never written to |
| `accounts[].skipDestinations` | don't mirror this source into these aliases (e.g. a shared calendar already visible there) |
| `accounts[].ignoreEventsUpToMinutes` | skip short timed entries (reminders) |
| `sync.busySummary` | block title template, `{labels}` is replaced |
| `workMode.blockAccount` | where the Work Mode block lives |
| `workMode.workAccounts` | calendars whose events stretch the daily window |
| `workMode.markerAccount` | optional calendar holding `work_start`/`work_end` markers |
| `workMode.schedule` | `Mon`..`Sun` → `["HH:MM","HH:MM"]` |
| `commute.*` | accounts to scan, home address, Routes key file, travel mode, margins |

Environment overrides: `CALMIRROR_CONFIG`, `CALMIRROR_GOG`, `CALMIRROR_TZ`, `CALMIRROR_HOME_ADDRESS`, `GOOGLE_ROUTES_API_KEY`, `CALMIRROR_ROUTES_KEY_FILE`. Keep secrets out of the config file you share; put the Routes key in `~/.config/calmirror/routes-api-key` (`chmod 600`) or in an `EnvironmentFile`.

### 3. Try it

```sh
node ~/calmirror/bin/calendar-sync.cjs --dry-run
node ~/calmirror/bin/commute-sync.cjs --dry-run
node ~/calmirror/bin/work-block-setup.cjs   # once, creates the recurring Work Mode block(s)
```

Each run prints a JSON summary. Work Mode markers are optional: create recurring 15-minute events in the marker calendar with private property `calmirror_marker=work_start` / `work_end`.

### 4. Schedule with systemd

```sh
mkdir -p ~/.config/systemd/user
cp ~/calmirror/systemd/*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now calmirror-calendar-sync.timer calmirror-commute-sync.timer
loginctl enable-linger "$USER"   # keep timers running when logged out
journalctl --user -u calmirror-calendar-sync.service -n 20
```

Busy sync runs every 5 minutes, commute every 15.

## Notes

- `propPrefix` changes the extended-property namespace; changing it on a live setup makes calmirror treat previous blocks as foreign, so clean them up first.
- Mutations use `sendUpdates=none`; nobody gets notified.
- Online-only locations (Zoom/Meet/Teams/…) don't get commute blocks.

## License

MIT
