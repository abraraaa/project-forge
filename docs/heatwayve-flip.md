# Heatwayve flip — the runbook

Execution checklist for flip day. Everything here was mapped across the
2026-07-16→26 conversations ("we shouldn't push forward with heatwayve
until we've mapped every permutation that could cause a break"). Nothing
in this file executes anything — it exists so flip day is a checklist,
not an improvisation.

**Gate:** fires after the delta-sync soak clears (boss call). Current
state: heatwayve.app 307→theforged.fit (temporary freeze, app-layer);
bonus TLDs (.fit/.space/.life) 301→heatwayve.app permanently.

## Invariants — the things the flip must NOT touch

- **rpId stays `theforged.fit` forever.** Passkeys are bound to it; the
  two-origins-one-rpId allow-list + `/.well-known/webauthn` ROR already
  serve both origins. NEVER migrate the rpId — that orphans every
  credential.
- **`forge:` localStorage prefix and `forge/` blob paths are permanent
  internals.** Deep plumbing, invisible to users, renaming = a migration
  with real blast area for zero felt benefit. Decided 2026-07-17.
- **DB row keys (profile names) unchanged.** The DB is origin-agnostic.

## Origin-change physics (accepted, with mitigations)

localStorage, service-worker caches, and PWA installs are all PER-ORIGIN.
Moving users to heatwayve.app means, on first visit:
- **LS starts empty → full hydration from the cloud.** Delta cursors
  re-adopt automatically (full pull hands out a cursor + acknowledges
  the baseline — shipped with #77). Synced state survives wholesale.
- **Device-local stores reset** (accepted losses, enumerate honestly):
  live session draft, pendingSession stash, tonnage-milestone seen,
  iOS-install-dismissed, onboarded flag. DECIDED 2026-07-27: onboarding
  re-showing is FINE — it's one screen, and the sign-in path's migration
  greeting carries the warmth for returning users; suppression machinery
  would outweigh the moment it removes.
- **The PWA must be re-added to the home screen** — a new origin is a
  new install. The re-add nudge (below) is the product answer.
- **Photo cookie (`hw_photos`) doesn't travel** — first Locker Room
  reveal on the new origin runs one ceremony, then the sliding window
  resumes. Already the designed behaviour for a new device.

## The flip, in order

1. **Pre-flight (no user impact)**
   - [ ] Delta soak signed off by the boss (diag delta card clean on
         both his devices).
   - [ ] Snapshot cron has ≥1 green run (restore point exists).
   - [ ] Verify `/.well-known/webauthn` serves both origins from prod.
2. **Repo PR — the rename sweep** (one PR, boss reviews copy)
   - [ ] Manifest: swap to staged `public/heatwayve/manifest-staged.webmanifest`
         content (name Heatwayve, icons → `/heatwayve/heatwayve-glass-*.png`;
         legacy `/icon-*.png` paths stay in place for installed PWAs).
   - [ ] User-visible "Forge" strings → Heatwayve (components + metadata;
         NOT the `forge:`/`forge/` internals, NOT lib comments).
   - [ ] README rework (parked entry: identity + voice, heatwayve.app
         links, fact-check against delta-era architecture).
   - [ ] SEO: `app/layout` metadata, OG image text, robots/sitemap URLs
         → heatwayve.app.
   - [x] Migration copy + PWA re-add nudge — PRE-BUILT, DORMANT
         (2026-07-27, `lib/origin.js` gating): the install overlay
         re-fires on the new origin by localStorage physics (per-origin
         dismissed flag) and swaps to the migration voice ("Same fire,
         new home / Add Heatwayve back"); the welcome-back beat greets
         the move ("Forge grew into Heatwayve — your story came with
         it"). Wakes automatically when heatwayve.app is primary; the
         rename-sweep PR need only review the copy.
   - [ ] SW: no change needed (per-origin; new origin = clean install).
3. **Vercel/DNS (boss's hands, ~10 min)**
   - [ ] Remove the app-layer 307 freeze block from `next.config.mjs`
         (rides the rename PR, deploys with it).
   - [ ] In Vercel: make heatwayve.app the primary domain.
   - [ ] Add app-layer PERMANENT 301 theforged.fit → heatwayve.app with
         carve-outs that must keep serving on the OLD origin:
         `/.well-known/webauthn` (ROR must stay fetchable at the rpId
         origin) and `/api/auth/*` (ceremonies negotiated against the
         rpId origin). `/api/sync` + `/api/photos` follow the redirect
         fine (clients re-request).
   - [ ] Bonus TLDs: confirm .fit/.space/.life still 301 → .app.
4. **Verify (the Sarah walkthrough, on device)**
   - [ ] theforged.fit URL → lands on heatwayve.app, profile hydrates
         from cloud (streak/history intact).
   - [ ] Existing passkey signs in ON heatwayve.app (ROR path).
   - [ ] Locker Room reveal: one ceremony, cookie set, second visit
         zero-prompt.
   - [ ] Re-add to home screen; icon is the glass Heatwayve mark;
         standalone chrome blends (the #72 collar work is origin-blind
         but eyeball it).
   - [ ] diag-sync: mode=delta, cursor present, dirty=0 after first sync.
   - [ ] Log a set end-to-end; check it lands in Neon (session row).
5. **Aftermath**
   - [ ] Watch Vercel logs for 404s/auth failures for a day.
   - [ ] Final deep audit fires (Task #8) — includes the test-suite
         pruning brief, diag sunset question, transition-era code
         removal (blob token fallback, legacy PUT path).

## Rollback

The flip is config + copy — no data moves. Rollback = re-point the
primary domain and restore the 307 block. Passkeys unaffected in either
direction (rpId never changed). LS on heatwayve.app persists for anyone
who visited; harmless.
