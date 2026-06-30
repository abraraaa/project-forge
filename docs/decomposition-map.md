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

- **3c-final — extract `TakenNameModal`.** 🔪 Safe, self-contained. Clears
  the last sub-component blocking ProfileScreen's extraction.
- **3d-prep — extract `ProfileScreen` → `components/ProfileScreen.jsx`.**
  Pure decomposition, still rendered by ForgeApp at the gate exactly as now.
  ~744 lines off the monolith. No routing, no behaviour change. Safe.
- **3d-route — ⚠️ DESIGN CALL.** Split the double-duty: keep the entry gate
  rendering ProfileScreen at `/` (correct — entry lives at root); make the
  switch/settings use a `/profile` route. Requires lifting `activateProfile`
  out of ForgeApp into a shared module/context (the app's first real shared-
  state extraction). PAUSE here for a decision before cutting — this is the
  artery.
- **3e/3f — Home + Session routes, then `<ViewTransition>` migration** (per
  frontend-audit.md). Home/Session extraction follows the same file-first
  pattern; Session carries the draft-rehydrate + popstate exit-guard.

**Principle:** file-extraction (decomposition) is always safe and goes first;
route-ing — which moves identity/activation logic — pauses for a design call.
