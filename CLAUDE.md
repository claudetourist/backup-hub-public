# Backup Hub app: lessons learned (read before changing code)

Each line was learned the hard way on real data. Add a line when a new one is learned; keep it to one line each.

## The window must never freeze
- Main thread = window. Any database read over a few hundred rows, any folder or drive walk, any adb output parsing runs in the query worker, a utility process, or sliced (`src/main/sliceWork.ts`, at most ~20 ms per slice). Never inside an IPC handler directly.
- Screens render at once with a placeholder ("Counting...") and fill in later.
- Every new IPC call or screen gets a main-thread block test on a big generated db (limit 250 ms; see `phoneBackup/mainThreadBlock.test.ts`, `bigCatalog.testUtil.ts`).
- A real catalogue has ~1.1M file rows and 200k+ copy rows. Code that is fast on fixtures can take seconds there.
- Freeze recorder: `[slow] ipc <channel> held the main thread` and `[stall] ... window calls: ...` in `backuphub.log` in the logs folder (`%APPDATA%\Backup Hub\logs` by default). `BACKUPHUB_PROFILE=90` writes a CPU profile (logs folder) for 90 s. Use them instead of guessing.
- The second drive's list is made from the index after the listing's quick look (worker); never walk or hash a drive on the main thread (`mirror/mirrorScan.ts`, block test `mirror/mirrorMainThreadBlock.test.ts`).
- 24 Nov 2026: Backups froze 6-8 s every open: `checkOldCounts` read 203k copy rows on the main thread.
- 25 Nov 2026: planning 100,000 folder files blocked the window 673 ms because naming them was one plain loop; every loop over files is a generator step (`folderBackup/folderPlan.ts` `placeSteps`). A test that writes 100,000 files must give the event loop a turn every few hundred, or the test runner reports a timeout.
- 25 Nov 2026: SHA-256 of a copy's blocks and big result transactions (relinks, check results) ran on the main thread and stalled the window up to ~2 s: hash on `hashing/blockDigest.ts`'s worker, write results with `writeSliced`; a watchdog must wait one timer tick after a synchronous block before it reads (else it reads 0 ms).
- 26 Nov 2026: a 14 s freeze after Pause on a Google copy: a sha probe with `INDEXED BY idx_files_sha256` walks every same-sha row (one sha has ~1,000 copies); use `idx_files_sha256_live` and limit the place (`googleCopyMainThreadBlock.test.ts` has a sha with 1,000 copies).
- 23 Nov 2026: a 37 s freeze: a lookup without `INDEXED BY idx_files_size_name` walked a whole folder per phone file. Check EXPLAIN QUERY PLAN for queries inside loops.

- 25 Nov 2026: one job that copied the missing files AND read-compared 40,940 old same-size files ran at 6 files a second (about 6 h). Keep "copy what is missing" and "prove old copies" as separate jobs; read the first drive's file only when its checksum is unknown; write the index in batches, never one transaction per file.
- 25 Nov 2026: a trigger that wrote the search index on every file insert cost +87% and a 2.6 s merge spike; the index is filled by the worker (`query/searchIndexKeeper.ts`) and pauses while a job runs, because main-thread writes wait for the worker's write lock (slices of 400 rows: p95 220 ms, max 740 ms).

- 26 Nov 2026: Pause holds a job only at `ctx.yield()`, which belongs BETWEEN files; inside a file (hashing, reading, adopting a temp) use `ctx.turn()` / `turnOf(ctx)` so a Pause lets the file finish and be recorded (a hold mid-file left a temp file and lost the file when the app then closed). A job that keeps results in memory registers `ctx.beforeHold(save)`.
- 26 Nov 2026: a Google upload's session address and offset live in the job checkpoint (`inFlight`), so a closed app carries on from Google's own answer; the address is secret-like: never log it.

## Folders
- The listing's quick look skips a folder whose own date did not move, and a file edited in place does not move its folder's date: a folder backup walks every file (`realSourceFor` uses the full walk). Found by a real-folder test (25 Nov 2026), not by the fake world.
- The Google Keep notes are private: names, sizes and checksums only. The one read of a note is the copy stream; `keepSync.test.ts` fails if anything else opens or reads one, or if the text reaches a log, an answer or the database.
- OneDrive online-only files are never opened: Windows is asked about the attributes right before each file (`cloudStates`), and "could not tell" counts as online only.

- 25 Nov 2026: a renamed or moved file is the same row, matched by NTFS file id + size + date within 2 s after a COMPLETE look only (`listing/moveMatch.ts`); the old row (checksum, copy links) keeps its id and the new duplicate is dropped. The id is saved only for the laptop and OneDrive (`trustFsId`), never for a drive or phone; rows get theirs at the next full look without counting as a change. Test files created in a test must have `first_seen_at` after the look's start, so tick the fake clock between looks.

## Phones (adb, toybox, mksh)
- 26 Nov 2026: phone file rows are stored WITHOUT a leading slash ("sdcard/DCIM/...") and have no SHA-256; drive copies link by origin_file_id and carry the checksum. Normalize paths and look Google up by the drive copy's checksum (the free-up check found nothing ready until both were fixed).
- /sdcard is a link: `find -H`. `find -exec stat {} +` overruns the argument limit: use `-printf`. mksh while-read loops are very slow: use the phone's awk.
- adb kill-server after phone work. PhoneBackup's `--list-pending` writes its ledger: never run it.

## Safety
- Never change anything in a backup drive's data folder (its MyData folder) or a ledger.db; backups only add dated folders. Dev runs set BACKUPHUB_DATA_DIR to a temp folder, never the real data folder.
- No personal path, name, device serial, account or secret in the repository: `src/publicReady.test.ts` fails if one is added. Settings are environment variables or app settings with generic defaults (see the settings section of `docs/CODEMAP.md`).
- The packaged exe is `BackupHub.exe` (no space): check it is closed with `tasklist /FI "IMAGENAME eq BackupHub.exe"` before packaging or copying the db.
- Never kill all node processes; only those started from this repository's folder.

## UI
- Untick = skip this time; Exclude = never back up. Keep them visibly different, with Undo next to each exclusion and one compact Exclusions list per backup.
- Backups: one list of all backups, one page per backup (#/backups/<id>); a panel on a page never repeats the backup's name and never shows words of another kind (phone words only on phone backups; the old-tool warnings only when `fromOldTool`).
- Audit the whole screen for basic gaps (tick all, one clear action per panel, screens agree, no walls of text), not only the reported problem.
