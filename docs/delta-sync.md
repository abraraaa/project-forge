# Delta sync — settled design (2026-07-25)

The #2 design note, settled in conversation with the boss. This kills the
sync-payload monolith and closes #2/#3/#8/#12/#14/#17 as one family.

## Decisions (boss, 2026-07-25)

- **Delta via `updated_at` over Neon rows** — not blob windowing. The DB
  migration already decomposed the server (sessions = row per record,
  meta = row per field); the monolith survives only on the wire.
- **Blob retires to snapshot-only.** Neon is durable enough even at free
  tier; the blob snap exists as a restore point for the disaster class
  where we somehow bypass every control and issue an invasive wipe.
- **Ordering: delta-sync → Heatwayve flip → final deep audit.** The
  monolith is a live tax (every tap ships full history; every sync pays
  dual-write ops); the flip has no decay. One variable per soak window.
  The deep audit then examines a fully settled system once.

## Protocol

- **History**: append-only records with unique ids. `updated_at` column on
  sessions rows (backfilled). PUT sends only records created/touched since
  the client's last push (the pending-queue machinery already knows).
  `GET ?since=<cursor>` returns only newer rows. Fresh installs still take
  the full pull — that's hydration, unchanged.
- **Meta**: per-field rows gain `updated_at`. Client sends only dirty
  fields. Merge algebra unchanged — same rules, applied per field. The
  mergeMeta whitelist (#8) dies naturally: fields become opaque rows.
- **Client bookkeeping**: one sync cursor per profile + a dirty-field set —
  the skeleton pushDeferred (#3) was built for. It finally gets callers.
- **No tombstones**: the only delete that exists is whole-profile.
- **Dominoes**: #12 (delta payloads fit keepalive's 64KB budget → pagehide
  save-point becomes real), #14 (a stale tab can only re-stamp fields it
  touched), #17 (value+stamp collapse into one row).

## Snapshot cron (replaces dual-write)

WRITE-ONLY, by construction — no delete authority exists in the job (wipe
protocol rule 4: no standing delete authority, no sweepers). Two
deterministic generations per profile, overwrite-in-place:

    forge/snapshots/daily/<profile>/{meta,history}.json
    forge/snapshots/weekly/<profile>/{meta,history}.json

Restore points: ≤24h and ≤7d. Nothing accumulates, so nothing ever needs
sweeping.

## Rollout

1. **PR A (server)**: `updated_at` columns + backfill, `?since` GET, delta
   PUT shape. Fat paths kept — old clients unaffected, no flag-day.
2. **PR B (client)**: cursor + dirty-field tracking, delta push/pull,
   keepalive lifecycle flush. Fat pull remains the fresh-install path.
3. **PR C**: retire meta/history dual-write → snapshot cron; ledger closes
   for the whole family. Photos/credentials/tokens stay blob.
