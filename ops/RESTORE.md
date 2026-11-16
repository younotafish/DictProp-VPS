# Restoring production's database

Production keeps everything in one SQLite file, `/opt/dictprop-vps/data/dictprop.db`, on the VPS's one disk. This runbook says where copies of it are, what restoring one loses, and how to restore one onto the same VPS or a new one. This Mac can't SSH to the VPS, so the restore itself runs from a machine that can, or from the provider's web console.

## Where the copies are

1. **The VPS's backup slot**, `/opt/dictprop-vps/data/backups/`, holds one whole copy: `pre-<operation>-<UTC time>.db`, taken before an import or a repair writes or for an off-site backup, or `dictprop-<UTC time>-<commit>.db`, taken by a deploy. A later import or deploy reuses a copy under 12 hours old and otherwise replaces it. It survives a bad import or a broken release, but not a lost disk or a lost VPS.
2. **The off-site copies**, on this Mac in the checkout's `data/offsite-backups/`: `dictprop-db-<UTC time>-<run id>.dpb`, the newest three, each beside a `.json` sidecar (`runId`, `purpose`, `createdAt` when it was kept, `encryptedBytes`, `sha256`, `plaintextBytes`). Each is a gzipped tar of:
   - `manifest.json`: the database copy's name and size, its page size and page count, the row counts of its main tables, and `createdAt`, when its snapshot was taken;
   - `Caddyfile`: the live `/etc/caddy/Caddyfile`, with the site blocks the static-site workflows spliced in;
   - the database copy, the slot's copy at the time, by its slot name.

   It's encrypted by `scripts/offline/bridge-crypto.mjs` for `db-backup:<run id>` only. Not in it: `.env` (its secrets come from their providers' consoles), the speech cache in `data/tts` (the TTS Backfill workflow makes it again), the static sites' files (their workflows put them back) and logs.

`scripts/offline/offsite-backup.sh` makes the off-site copies; the enrichment cycle runs it last, every six hours. Once the newest is 162 hours old, it dispatches the Off-site Database Backup workflow (`.github/workflows/offsite-backup.yml`), which streams the slot's copy, under 12 hours old or fresh, into its run's encrypted artifact; then it downloads the artifact, checks every byte of it without writing plaintext, keeps it, and deletes the artifact and the run's log. It never dispatches while production is busy or doesn't yet run the commit whose server script the workflow calls, and after a failed attempt it waits a day.

## What a restore loses

Restoring a copy loses every review and edit made after its snapshot: `createdAt` in an off-site copy's `manifest.json`, the time in a slot copy's name. For an off-site copy that is up to 162 hours, plus the time since the last backup ran, plus up to 12 more hours when the workflow reused the slot's copy. For the slot's copy it is the time since the last import or deploy, plus up to 12 hours. So restore the newest copy that passes its check, which is usually the slot's while the VPS's disk survives.

## The bridge key

Every off-site copy is useless without the bridge key, `~/.config/dictprop/sentence_bridge_key` (the `SENTENCE_BRIDGE_KEY` secret, which GitHub never shows again). Keep a copy of the file off this Mac, in a password manager say. Rotating the key strands every older copy: keep the old key file beside them, mode 600, until they have aged out.

## The first backup

The cycle makes no backup while `data/offsite-backups/` holds none, so the first one runs by hand and its outcome is watched; after it, the cycle makes one every 162 hours:

1. Check that no cycle is running and hold the cycle lock (CLAUDE.md, Offline Data Bridge).
2. From the repository root, once the deploy of the commit that added the backup has succeeded:

       OFFSITE_BACKUP_INTERVAL_HOURS=0 GH_BIN=.tools/gh scripts/offline/offsite-backup.sh "$(git rev-parse vps/main)"

   It ends with `off-site backup complete: ...`. A line saying production doesn't run the commit yet, or is busy, means nothing was tried; run it again once the deploy or import has finished. `OFFSITE_BACKUP_INTERVAL_HOURS=0` forces an attempt even after a failed one.
3. Check that the run of Off-site Database Backup is green and shows no artifact any more, and that `data/offsite-backups/` holds one `.dpb` and its `.json`, both mode 600 in a folder of mode 700. `plaintextBytes` in the sidecar is the tar's size, slightly more than the database's.
4. Decrypt the copy and check it once, as below: that proves the key, the copy and this runbook.
5. Release the lock and `launchctl kickstart` the agent.

Nobody could check these limits before the first run, so they are the likely causes of a failure, and the run's log says which: GitHub's size limit for one artifact (the copy is about 6 GB), the runner's free disk (about 14 GB), the VPS's free disk when the slot needs a fresh copy (the script's error says how much it needs), and the time the download takes through the proxy (`OFFSITE_BACKUP_DOWNLOAD_SECONDS`, 3600 unless set). If the size is what fails, the fallback is a slim backup without `image_blobs` and `item_images`, a filtered `VACUUM INTO` copy, which isn't built.

## Check and decrypt an off-site copy

Check one without writing any plaintext (its run id is the last part of its name):

    node scripts/offline/bridge-crypto.mjs verify --gunzip --purpose db-backup:<run id> --in data/offsite-backups/<copy>.dpb

Decrypting writes plaintext production data, the whole library: do it in a private folder outside the repository, and delete the files when done.

    mkdir -m 700 ~/restore && cd ~/restore
    node /Users/cjs/DictProp-VPS/scripts/offline/bridge-crypto.mjs decrypt --gunzip --purpose db-backup:<run id> \
      --in /Users/cjs/DictProp-VPS/data/offsite-backups/<copy>.dpb --out backup.tar
    tar -xf backup.tar && rm backup.tar
    cat manifest.json
    sqlite3 <database copy> 'PRAGMA quick_check'
    sqlite3 <database copy> 'SELECT COUNT(*) FROM items'

`quick_check` must print `ok`, and the counts must equal the manifest's. Nothing checks a copy's integrity when it's made, since that would read the whole database on the small VPS every week, so this check is the one that counts.

## Restore onto the same VPS

When the disk survived but its data didn't (a bad import, a bad release, a mistaken write):

1. On this Mac, check that no cycle is running and hold the cycle lock, so no import starts. On GitHub, check that no deploy or bridge workflow is running.
2. On the VPS, choose the copy. The slot's copy is in `/opt/dictprop-vps/data/backups/`; an off-site copy has to be decrypted on this Mac first, and its database file moved to the VPS through a machine that can reach it.
3. Check the copy on the VPS: `python3 -c "import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA quick_check').fetchone()[0])" <copy>` prints `ok`.
4. Check the space: `df -h /opt/dictprop-vps`. The disk holds about two databases. Moving the live one aside takes no space; copying a restored file in takes a database's worth. To restore the slot's copy, move it into place rather than copying it.
5. Stop the app and move the live files aside, all three. A `-wal` file left beside a different database would be replayed into it and damage it.

       cd /opt/dictprop-vps
       docker compose stop app
       mkdir -p data/pre-restore
       mv data/dictprop.db data/pre-restore/
       mv data/dictprop.db-wal data/dictprop.db-shm data/pre-restore/ 2>/dev/null || true

6. Put the copy in place, `mv data/backups/<copy> data/dictprop.db` or `cp <copy> data/dictprop.db`, and remove the slot copy's own `-wal` and `-shm` files if it left any. Then `docker compose start app` and check `curl -fsS http://localhost:3000/api/health`.
7. Clear one device's site data (below), sign in, and look at the library. Keep `data/pre-restore/` until it checks out, then delete it: the disk can't hold it for long.
8. Release the lock on this Mac and `launchctl kickstart` the agent.

## Rebuild on a new VPS

When the disk or the VPS is gone, from an off-site copy:

1. Set up Ubuntu with Docker and its compose plugin, Caddy, python3, and zsh as root's login shell (`chsh -s /usr/bin/zsh root`): the workflows' remote scripts are written for it. Add the swap file CLAUDE.md describes.
2. Install the backup's `Caddyfile` as `/etc/caddy/Caddyfile`, with no whitespace before a site's address, then `caddy validate --config /etc/caddy/Caddyfile` and `systemctl reload caddy`.
3. `git clone https://github.com/younotafish/DictProp-VPS.git /opt/dictprop-vps`. Write `/opt/dictprop-vps/.env` from the providers' consoles: `DEEPINFRA_API_KEY` (DeepInfra), the Google OAuth client's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud console), `OWNER_GOOGLE_EMAIL`, and `PUBLIC_ORIGIN` if it isn't `https://dictprop.online`.
4. Put the restored database at `/opt/dictprop-vps/data/dictprop.db` and create `data/backups/`.
5. Point the repository at the new VPS: its IP in every workflow's `host:` and in `scripts/offline/vps-ssh.sh`; its host keys in `VPS_KNOWN_HOSTS` (`sentence-backfill.yml`, `offsite-backup.yml`) and its ECDSA key's fingerprint in every `VPS_SSH_FINGERPRINT` (`test/workflows/bridge-workflow.test.ts` checks both keys' fingerprints); a new deploy key in root's `authorized_keys` and in the `VPS_SSH_KEY` secret. Point the DNS A records of `dictprop.online` and `www.dictprop.online` at the IP.
6. Push to main. The deploy pulls the release image and starts the app on the restored database; check that it's healthy.
7. Run the static-site workflows to put their files back, and dispatch TTS Backfill to make the speech cache again.
8. Clear every device's site data (below).

## After any restore: every device

Until backup lineage ships (critic-02 in the 2026-11-15 audit), the server can't tell that it has gone back in time. Every device that synced after the copy's snapshot holds edits and server revisions the restored server doesn't know, and syncing would mix the two libraries. On each device, before using the app: open dictprop.online, clear its site data (Safari: Settings > Apps > Safari > Advanced > Website Data; Chrome: the site's settings > Delete data), reload and sign in again. What that device changed after the snapshot, unsent reviews included, is part of what the restore loses.

## Disk space

- This Mac: about 20 GB for three copies, and as much again while a download unpacks, since gh keeps the artifact's zip until it has extracted the copy.
- The machine that decrypts: the blob, the tar and the extracted database, about three times the database.
- The VPS: one database's worth of free space beyond what's there, for a restored file copied in.
