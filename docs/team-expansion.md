# Team expansion — the trust checklist

**Status: DORMANT.** Nothing here needs doing today. This file exists so that
the day a second person gets access, the decisions are already made and nobody
is improvising about other people's bodies.

**Trigger:** the first time anyone other than the boss is given any form of
access — app-level admin, Vercel project, database, or storage. Realistically
that means Heatwayve outgrowing one person, which the boss put at roughly
**10k active users**. Until then this is a thought exercise, deliberately.

**The thing being protected:** progress photos. Everything else Heatwayve
stores — training history, bodyweight, streaks, profile names — is personal
but not exposing. The photos are the only asset where a curious insider is a
different category of problem from a data leak. Design accordingly: the
question is never "is our data safe" in general, it is *"who can see someone
undressed, and how would we know."*

---

## What the architecture already gives you (verified 2026-07-27)

Good news first, because it changes what the checklist has to solve.

- **There is no admin backdoor to photos.** `app/api/photos/route.js` contains
  zero references to `ADMIN_PROFILE` or any admin concept. The gate compares
  the token's STORED profile against the REQUESTED profile and derives every
  path from the authorised value. An app-level admin can see their own photos
  and nobody else's — not by policy, but because no code path exists.
- **`ADMIN_PROFILE` is bug triage and nothing more.** It gates
  `/api/bugs` GET/PATCH. It grants no read of sync data, no read of photos, no
  destructive verb. It names an identity; it does not widen one.
- **Photo bytes are not in the database.** The `photos` table holds
  `blob_path`, never image data. A database compromise yields training history
  and blob *paths* — not the images, which need either the storage credential
  or a valid photo cookie.

**So the real boundary is not the app. It is `BLOB_READ_WRITE_TOKEN`.** Anyone
who can read Vercel's env vars can download every photo in the store directly,
bypassing every gate the app has, leaving no trace in any app-level log.

Say that plainly to anyone who asks how safe the photos are: *the app enforces
it properly; the operator can bypass it entirely.* Today the operator is one
person and that is the whole control.

---

## Decision of record — end-to-end encryption: CONSIDERED, DECLINED

**Boss, 2026-07-27:** *"I think E2E would be nice but recognise the need for
Heatwayve to be seamlessly tech. I'll take the onus of keeping users safe
rather than creating obstacles to sign up and experience."*

E2E is the only option that makes operator trust unnecessary: encrypt in the
browser with a key derived from the user's passkey (WebAuthn PRF) before
upload, and the server — and every future admin — stores ciphertext nobody
with infrastructure access can read.

It was declined on product grounds, not technical ones, and the reasoning
should survive:

- **Recovery becomes unforgiving.** Lose the passkey, lose the photos, forever.
  There is no reset and no support path, because the design deliberately
  removes the operator's ability to help. For a training app people use for
  years across replaced phones, that is a serious promise to make.
- **Multi-device gets thorny.** PRF output is per-credential, so a second
  device's passkey derives a different key. Solving it means key-wrapping and
  a sync-the-wrapped-key story — real architecture, not a weekend.
- **It taxes the moment that matters most.** Signup and first photo are where
  Heatwayve either feels effortless or feels like homework. Key ceremonies
  belong to apps whose users arrived expecting them.

**Revisit if:** photos become a headline feature for strangers rather than a
private tool for a trusted few; or a jurisdiction/regulatory requirement makes
operator access itself a liability; or WebAuthn PRF recovery patterns mature
enough that "lose your key, lose your photos" stops being the honest summary.

---

## The checklist — in order, cheapest first

### 1. Grant app admin, never infrastructure — FREE, works today
The default for any new admin: add them to `ADMIN_PROFILE`, and do **not** add
them to the Vercel project. They get bug triage — the actual job — without the
storage credential. The architecture already enforces the split; this step is
purely a decision not to undo it.

This covers the overwhelming majority of "we need help with support."

### 2. Split the photo store from everything else — LOW COST, real teeth
Move photos to their own Vercel Blob store with its own token, so someone who
legitimately needs deploy or debugging access does not automatically inherit
photo access. One credential with a huge blast radius becomes two with
different ones.

Do this the first time anyone needs infrastructure access for any reason.

### 3. Log photo reads — deterrence and detection
Record who read which photo and when. Honest about its limits: it does not
*prevent* anything against someone with storage access (they bypass the app),
and logs are weak against someone who can edit them. What it does buy is that
casual snooping through the app becomes visible, and people behave differently
when they know access is attributable.

### 4. End-to-end encryption — the only true answer
See the decision above. Recorded here as the known ceiling, so that if the
trust model ever has to stop depending on the operator, we already know what
that costs and why we did not pay it earlier.

---

## Rules to hand any new admin, in plain words

Not a policy document — the actual sentences.

- You have bug triage. You do not have anyone's photos, and the app will not
  give them to you; there is no code path.
- If you are ever given infrastructure access, you can technically read every
  photo in storage. That access is granted on the understanding that you never
  will, and there is no technical control stopping you — only this agreement.
- If you need to debug something involving a real user's photos, ask them
  first. Every time. "I needed to check something" is not consent.
- If you find you *can* see something you should not be able to, that is a bug
  and it is urgent. Report it; nobody will be annoyed.

---

## Related

- `docs/audit-2026-07-security.md` — the security posture this builds on
  (J1 profile binding, the wipe gate, cookie scoping, rotation caps).
- Token hashing at rest: assessed 2026-07-27 as **low risk, low cost, not
  urgent**. It protects the DB-leak-to-photo-access bridge specifically — a
  Neon compromise where Vercel is untouched. Cheap whenever it is wanted
  (tokens are ≤7 days, so no backfill is needed — new tokens hash, old ones
  expire within a week). Not done; recorded as a conscious hold.
