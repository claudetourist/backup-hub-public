# Backup plans redesign (6 Nov 2026)

**UI WORDS (user, 6 Nov):** a plan is shown as **a backup**; the screen is **Backups**; run button **Back up now**; dated app-data folders are **copies**. Places/Sources screen = **Devices**, with a **Cloud accounts** section. Rail: Home, Backups, Devices, Search, Settings. (Code and tables may keep plan/collection/place names.)

Design notes for the backups screen. The safety rules (never overwrite, never delete without three checked copies) still apply in full.

## 1. The idea
A **plan** = What (one source) + Where (destinations) + When (schedule). **Each destination keeps its own state**, so the
user tracks a source by opening its plan ("T7: copied 2 days ago. Seagate: 19 days, not plugged in. Google: 94%"). A plan runs
for whichever destinations are reachable; the others catch up later. There is no "fallback drive": two drives = two copies.

Plans are NOT a parallel system: a plan is a collection plus destinations and a schedule. Keep the `collections` and
`collection_roots` tables (UI says "Plan"); add columns and two tables (section 4). Copies still run through the existing jobs
(`copy.toLocal`, `copy.toDrive`, phone backup, saved copies).

## 2. Plan kinds
| Source kind | What | Copy mode | Destinations allowed |
|---|---|---|---|
| `folders` | Folders from the catalog (laptop or OneDrive place); today's collections | new (copy what is new, never delete) | drives, Google group |
| `appdata` | Laptop app data list (section 5) | dated (keep N) | drives ONLY (Google locked off, also refused in main) |
| `phone` (Batch 10) | Phone folders | new | drives, laptop folder, Google group |
| `self` | Backup Hub itself: database copy + settings file (drives), recovery copy (one Google account) | dated (the existing saved copies and recovery job) | drives, one Google account |

OneDrive is just a `folders` plan with roots in the OneDrive place (online-only files show as "not on this PC"; never downloaded silently).
"Laptop important to Gmail" is just a second `folders` plan (no per-destination filters).

Starter plans made once on the first start of the new version (user edits them): "Laptop app data" (T7 + Seagate2TB when their
drive cards are known) and "Backup Hub itself" (same drives; recovery copy destination stays empty/OFF until the user picks an
account). Existing collections become `folders` plans with no destinations: the plan shows "Choose where this plan copies to".

## 3. Destinations and runs
- Destination kinds: `drive` (by drive card id / name, never letter), `google` (a group of one or more account ids; the cloud
  copy planner spreads files by free space but only over the accounts in the group), `laptop` (a folder, Batch 10, phone only).
- State per destination: `new` mode = coverage (plan files with a same-content copy on that destination; for a Google group,
  on any account of the group) + last run; `dated` mode = date of the last good dated copy, size, skipped count.
- Schedule per plan: manual / weekly / "when a destination is connected and its last good copy is older than N days" (default
  for drives: 7 days; the weekly check and the plug-in event both just evaluate this one rule, in the existing builtin job tick).
- Automatic start is allowed ONLY for drive destinations (additive, local). Google destinations run by "Run now" + confirm
  until the user switches on "Run by itself" for that destination (default off).
- An automatic run makes its plan in main (same plan id + hash rules as today; the window never sends a plan) and starts it.
  Big plans: copy.toLocal handles 5000 files per run; while the drive stays connected the runner queues the next run until done.
- Every job started by a plan or by itself carries a plain `trigger` line ("Started by itself: T7 was plugged in, last copy
  8 days ago"), shown in the plan history and the Jobs list.
- Before any job on a drive: not USB trouble (section 6), >= 2 GB free, `assertWritable`. Otherwise the run is skipped with the
  reason shown on the destination row.
- One job at a time per physical drive for anything that reads or writes it (look again, fingerprint, copies, app data):
  queue per drive, so a spinning disk never thrashes.

## 4. Data (migration 0017)
- `collections`: add `source_kind` TEXT default 'folders', `copy_mode` TEXT default 'new', `keep_versions` INT default 8,
  `schedule` TEXT JSON, `cloud_allowed` INT default 1, `builtin` TEXT NULL ('appdata' | 'self').
- `plan_destinations` (id, collection_id, kind, place_id NULL, accounts JSON NULL, folder NULL, auto INT, enabled INT, created_at).
- `plan_runs` (id, destination_id, job_id, trigger, started_at, ended_at, outcome, files, bytes, skipped JSON, folder NULL).
- App data source list: setting `appDataSources` = [{ path: '%APPDATA%\\Notepad++', priority: 'high'|'medium'|'low', on: bool }].

## 5. Laptop app data (`appdata` plan)
- Paths use %APPDATA% / %LOCALAPPDATA% / %USERPROFILE% tokens, resolved per Windows profile at run time; `*` allowed in one
  segment (Firefox Profiles\*, Packages\Microsoft.MicrosoftStickyNotes_*\LocalState). Never hard-code a user or laptop name.
- Default list (user's spec, measured 6 Nov: ~700 MB per copy after excludes):
  High: %APPDATA%\Mozilla\Firefox\Profiles, %LOCALAPPDATA%\Claude-Data, %APPDATA%\Notepad++.
  Medium: %LOCALAPPDATA%\Google\Chrome\User Data\Default\Bookmarks (single file), %APPDATA%\Code\User, %APPDATA%\Cursor\User,
  %APPDATA%\Kiro\User, %APPDATA%\MongoDB Compass, %APPDATA%\Postman, %APPDATA%\Anki2.
  Low: %LOCALAPPDATA%\Packages\Microsoft.MicrosoftStickyNotes_*\LocalState, %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_*\LocalState,
  %APPDATA%\Scooter Software, %APPDATA%\vlc, %APPDATA%\qBittorrent, %APPDATA%\Microsoft\Windows\PowerShell\PSReadLine.
  (NOT %APPDATA%\Backup Hub: cache only. The real database is protected by the `self` plan, which runs on the same drive right
  after each app data run.)
- Exclude everywhere (folder names, any depth): Cache, Code Cache, GPUCache, DawnGraphiteCache, DawnWebGPUCache, ShaderCache,
  Crashpad, blob_storage, CacheStorage, cache2, startupCache, crashes, minidumps, datareporting; files *.tmp, *.lock, LOCK.
- Blocked (cannot be added, skipped even inside an added parent): %APPDATA%\gcloud, %APPDATA%\GitHub CLI, %USERPROFILE%\.config\gh.
- Editable in the plan page ("What"): add folder (picker), remove, priority, on/off. Missing folders show "not on this laptop".
- Job `appdata.snapshot` (heavy, per drive): target `<drive>\Laptop-AppData\<laptop name>\<YYYY-MM-DD>\` (second run the
  same day: `-2`); laptop name from thisDevice.ts (sanitised); inside, one folder per source named after its resolved path.
  Each file through the shared verified copy (section 7). Locked/unreadable (EBUSY, EPERM, EACCES) -> retried once at the end
  -> listed as skipped. The job never fails for skipped files: outcome `done_warnings` with "Close Firefox and run again to
  include 3 files" (group skipped files by app folder). SQLite files are copied as files with their -wal/-shm.
  Writes `manifest.json` (device id + name, date, each file: source path, size, mtime, sha256; skipped list) and `README.txt`
  (plain words: what this is, how to restore by hand, "contains passwords and sign-ins, keep this drive safe").
  Plain files, NO encryption (user decision 6 Nov: no BitLocker, risk accepted).
- Keep N (default 8): after a good run, older dated folders of THIS laptop on that drive (only folders with a manifest) become
  a "Remove N old app data copies (X GB)" item that needs the user's confirm (exact count and size). Deleting is done by one new
  module `appdata/prune.ts`, which may delete only `Laptop-AppData\<laptop>\<date>` folders that hold a manifest.json; add it to
  the static deleters allowlist test. Nothing is removed by itself.
- NEVER to the cloud: listing skips any `Laptop-AppData` folder on any drive (it never enters the catalog), the cloud copy and
  rebalance planners refuse any source under it, and main refuses a `google` destination on an `appdata` plan. Tests for all three.

## 6. USB trouble
`places/usbHealth.ts`: read the System log for disk 153 and UASPStor 129 events (Get-WinEvent, read only), map to the drive via
the physical disk (disks.ts). A drive with such events in the last 30 min is "having USB trouble": no job starts on it (per-drive
start gate), Places and the plan's destination row say "This drive is having USB trouble: check it before using it".
Checked before each job start on a drive and every 5 min while a drive is connected. Clears after 30 min with no new events.

## 7. Shared verified copy
Extract from localCopyJob.ts into `localCopy/verifiedCopy.ts`: copy to `<name>.bhpart`, flush, read back, hash compare,
rename; returns the hash. Used by copy.toLocal (unchanged behaviour) and appdata.snapshot. A USB dropout mid-file leaves only a
.bhpart (cleaned at the next run of the same job).

## 8. Screens (end state after Batch 10)
Five screens: **Home, Plans, Places, Search, Settings.**
- Plans (replaces Collections): list of plans, each with its destination rows (tick/warning + age). Plan page: What / Where /
  When / History, "Run now" per destination and for all. App data plan: the editable source list; skipped files of the last run.
- Phone screen and Clean up > Free up phone space fold into the Phone plan. "Safe to remove from the phone" = every destination
  of the Phone plan has a verified copy (replaces the "T7 + cloud" rule).
- Clean up > Laptop duplicates -> Places > Laptop card. Clean up > Rebalance Google -> Places > Google accounts.
- Jobs screen -> a drawer opened from the sidebar "working" line; each plan also shows its own history.
- Home: one row per plan with per-destination ticks/ages, then only things that need the user (drive not connected for N days,
  skipped files, "X GB not in any plan", app data older than 14 days, confirms waiting). The detailed cards move into plan pages.
- Saved copies, settings file and Google recovery copy panels -> the "Backup Hub itself" plan.
- Plain words: "Last checked 2 h ago" + one "Check now" instead of listing / look again / fingerprint / ledger / catalog.
- Settings > Advanced: Fleet v1 import, Shared with me (Google Drive), diagnostics.

## 9. Batches
- **Batch 9 (engine + Plans):** sections 2-7; Plans screen replacing Collections (list, plan page, destinations, schedule,
  history, Run now); app data plan incl. editable list; `self` plan wiring for database copy + settings to drives; trigger lines;
  per-drive queue; freshness fix (skip the start/plug-in look when the drive was looked at within refreshEveryHours).
  Rail: Collections becomes Plans; other screens untouched in this batch.
- **Batch 10 (screens):** Phone plan (Phone screen + phone clean-up fold in, phone read once to the first drive, other
  destinations copy from that drive), OneDrive starter plan, recovery copy in the `self` plan, new Home, Jobs drawer, Places
  (laptop duplicates, rebalance), plain words, Settings > Advanced, 5-screen rail; fingerprint order check (smallest first?).
- Then: package, the user reviews once; first real run = app data plan with ONLY Notepad++ switched on, to the T7.
