# Monolith decomposition map (PR3 3c → 3d)

Dependency analysis before the surgical extractions. Goal: know exactly what
each cut touches so we don't nick an artery (Profile = the identity gate).

Status legend: ✅ extracted · 🔪 safe to cut next · ⚠️ needs a design call.

---

## Shared primitives & sub-components

| Component | Lives in | Deps | Status |
|---|---|---|---|
| `useFadeIn` / `Fade` / `Card` / `Tag` / `CARD_SHADOW` | `components/ui.jsx` | tokens, React | ✅ |
| `SyncStatusCard` / `SyncNowRow` | `components/sync-cards.jsx` | storage (SyncStatus/backgroundSync/pushNow), tokens | ✅ |
| `ScrollDrum` | `components/ScrollDrum.jsx` | tokens, React (ITEM_H/VISIBLE internal) | ✅ |
| `BodyweightEditModal` (+Inner) | `components/BodyweightEditModal.jsx` | ScrollDrum, useModalA11y, tokens | ✅ |
| `TakenNameModal` | ForgeApp.jsx 1875–2019 | useModalA11y, hasPasskey/authenticatePasskey (webauthn), P.add/P.setActive (storage), React | 🔪 self-contained, all deps importable |

**Next cut (3c-final): `TakenNameModal`.** Despite "auth-touching", the auth
is just module imports (`@/lib/webauthn`, `@/lib/storage`) — no ForgeApp
closure coupling. Props in: name, webAuthnSupported, onClose, onActivate,
passkeyBusy, setPasskeyBusy, passkeyError, setPasskeyError. Clean, verbatim.

---

## ProfileScreen — the identity gate (ForgeApp.jsx 2129–2873, ~744 lines)

The big one. Full dependency surface:

**Sub-components rendered:** Fade ✅, SyncStatusCard ✅, SyncNowRow ✅,
ScrollDrum ✅, BodyweightEditModal ✅, **TakenNameModal** (🔪 cut first). →
*Once TakenNameModal is out, every sub-component ProfileScreen renders is an
importable module.*

**Module functions called (all importable):**
- storage: `P.list`, `P.getActive`, `BW.get`, `blobDelete`, `claimProfile`,
  `checkProfileExists`
- webauthn: `hasPasskey`, `registerPasskey`, `authenticatePasskey`
- programme: `FOCUS_SUMMARIES`, `FOCUS_OPTIONS`, `DEFAULT_FOCUS`
- a11y: `useModalA11y`, `haptic` · tokens: `T`

**Internal:** `wipeProfile` is a local closure inside ProfileScreen (line
2193) — travels with it. 21 useState / 3 useRef / 3 useEffect — self-managed.

**Props from ForgeApp (the coupling surface):** existing, current,
**onActivate (= `activateProfile`)**, onCancel, bodyweight, bwEditOpen,
setBwEditOpen, updateBodyweight, userFocus, onEditFocus.

### Verdict: extractable to a FILE cleanly; route-ing is the hard part

ProfileScreen takes everything via props or importable modules — so
**extracting it to `components/ProfileScreen.jsx` (still rendered by ForgeApp
as now) is safe decomposition** and sheds ~744 lines off the monolith.

But **routing it (3d) hits a real design question**, because ProfileScreen
serves DOUBLE DUTY:

1. **Entry gate** — `if(!activeProfile)` renders it at `/` for sign-in /
   onboarding. This CANNOT be a separate route you navigate to: with no
   profile there's nowhere to navigate *from*, and `/` must show the gate.
2. **Switch / settings** — `showProfiles===true` (tapped while signed in)
   renders the same component. THIS could be `/profile`.

The genuinely hard bit: `onActivate = activateProfile` — a large async
function in ForgeApp that sets the active profile and triggers full app
hydration, closing over ForgeApp state (`setActiveProfileState`, the seed
effect, etc.). For a `/profile` route to handle activation, that logic must
be **lifted out of ForgeApp's closure** into a shared module/context. That's
the first real "shared-state foundation" piece the migration needs.

---

## Staged plan (revised, surgical)

- **3c-final — extract `TakenNameModal`.** ✅ DONE (`044ee4d`).
- **3d-prep — extract `ProfileScreen` → `components/ProfileScreen.jsx`.**
  ✅ DONE. 745 lines moved verbatim; ForgeApp renders it at the gate exactly
  as before via import. Audit-scope verified clean pre-cut (the block
  contains no mutation primitives, so the ForgeApp-only mutation-coverage
  audit loses nothing). Orphaned imports pruned (TakenNameModal, sync-cards,
  checkProfileExists, blobDelete, authenticatePasskey); ScrollDrum /
  BodyweightEditModal / passkey helpers / FOCUS_SUMMARIES stay — ForgeApp
  still uses them elsewhere. ForgeApp: 5,688 → 4,470 lines across the
  decomposition arc.
- **3d-route — ✅ IMPLEMENTED (2026-07-02, decided same day).** User
  approved the recommendation: NO context/provider layer. Extract the
  non-React core of `activateProfile` (validate → claim → `P.add`/
  `P.setActive`) into a pure `lib/` function; the `/profile` route renders
  ProfileScreen reading straight from LS and, on activation, calls the lib
  core then `router.push("/")` — ForgeApp mounts fresh and hydrates from
  `P.getActive()` naturally. The gate stays at `/` untouched; ForgeApp's
  in-place path keeps a thin wrapper around the same core. Rationale:
  localStorage IS the app's shared-state layer (local is canonical) — the
  pattern `/performance` already proved. Known loose end to resolve during
  implementation: the focus picker renders in ForgeApp, so `/profile`
  either hosts its own or it gets extracted first. Sequencing note: doing
  Session (3e) first is equally acceptable if deep-link value should lead;
  destination unchanged.
  IMPLEMENTATION NOTES: activation + focus-save cores live in
  lib/profile-actions.js (tested); FocusPickerSheet extracted to its own
  file (both hosts import it); /profile renders components/ProfileView.jsx
  (LS-hydrated, ErrorBoundary-wrapped) and is a PLAIN full-page route —
  deliberately NOT @overlay-intercepted, because activating a different
  profile must remount the shell rather than leave the old profile's Home
  mounted underneath. Rotation summary from a route-side focus change is
  handed to the home shell via a one-shot LS stash (take-on-mount).
  showProfiles state retired from ForgeApp: the gate is now purely
  !activeProfile; Home's profile button router.push("/profile")s.
- **3e — ✅ IMPLEMENTED (2026-07-04).** File-first: HomeScreen →
  components/HomeScreen.jsx, session flow (Readiness/Session/Done +
  satellites) → components/SessionScreen.jsx, load-type helpers →
  lib/lift-translations.js. Route: /session renders
  components/SessionHost.jsx, which owns the whole session state machine
  and the finalise pipeline (moved from ForgeApp's done-effect, run as an
  event on the done transition). Handoff = one-shot SessionIntent LS stash
  ({sessionIdx} | {resume:true}); no intent AND no live draft → bounce to /.
  The planned popstate exit-guard proved unnecessary: the per-set-persisted
  draft makes back-navigation pause semantics for free (resume card on
  home; refresh/deep-link auto-resumes; only explicit Quit discards).
  Home projections (streak/weekDone/deloadOffer) re-derive from LS when the
  shell remounts — no context layer, same storage-as-store line as 3d.
  ForgeApp: 5,688 → ~2,150 across the arc.
- **3f — `<ViewTransition>` migration** (per frontend-audit.md): migrate the
  hand-rolled startViewTransition to Next's experimental viewTransition +
  @view-transition navigation:auto; retire bespoke VT CSS.

**Principle:** file-extraction (decomposition) is always safe and goes first;
route-ing — which moves identity/activation logic — pauses for a design call.
