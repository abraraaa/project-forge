import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { sql } from "@/lib/db";
import { newAccountId, newWebauthnUserId } from "@/lib/identity";
import { buildIdentityBackfill } from "@/lib/identity-backfill";
import { gatherBackfillInputs, backfillLogLine, requireAdminCeremony, BACKFILL_FRESH_MS } from "@/lib/identity-backfill-inputs";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// IDENTITY BACKFILL APPLY — INSERT-ONLY. Disabled unless
// IDENTITY_BACKFILL_APPLY === "1".
// POST /api/diag/identity-backfill/apply   (X-HW-Auth: <fresh ceremony token>)
//   body { confirm: <planHash the owner read on the dry-run> }
//
// Gates, in order, every one fail-closed: enable switch (403, before any
// read) → fresh full-scope admin ceremony (401/403) → confirm present (400)
// → re-plan from the live store: any conflict 409, hash mismatch 409.
//
// Writes, named — the only ones: INSERT … ON CONFLICT … DO NOTHING into
// accounts, handles and credentials. No update, no delete, no Blob write.
// Single statements; a rerun converges (it plans only what is missing).
// The ceremony token is not consumed (that would be a delete); it expires.

export async function POST(request) {
  const limited = rateLimit(request, "diag-identity-backfill-apply", 2);
  if (limited) return limited;

  if (process.env.IDENTITY_BACKFILL_APPLY !== "1") {
    return NextResponse.json({ error: "apply disabled" }, { status: 403 });
  }

  const gate = await requireAdminCeremony(request, { freshMs: BACKFILL_FRESH_MS });
  if ("error" in gate) return gate.error;

  let body = null;
  try { body = await request.json(); } catch { body = null; }
  const confirm = typeof body?.confirm === "string" ? body.confirm : "";
  if (!/^[0-9a-f]{64}$/.test(confirm)) {
    return NextResponse.json({ error: "confirm must be the planHash from the dry-run" }, { status: 400 });
  }

  const q = sql();
  if (!q) return NextResponse.json({ error: "no database configured" }, { status: 503 });

  let built;
  try {
    built = buildIdentityBackfill((await gatherBackfillInputs(new Date().toISOString())).input);
  } catch (e) {
    return NextResponse.json({ error: `backfill plan failed: ${e.message}` }, { status: 500 });
  }
  const { plan, writes } = built;
  if (plan.conflicts.length > 0) {
    console.log(backfillLogLine(plan, " apply=refused:conflicts"));
    return NextResponse.json({ error: "conflicts — nothing written", conflicts: plan.conflicts }, { status: 409 });
  }
  if (plan.planHash !== confirm) {
    console.log(backfillLogLine(plan, " apply=refused:hash"));
    return NextResponse.json({ error: "store changed — re-read the dry-run", planHash: plan.planHash }, { status: 409 });
  }

  const inserted = { accounts: 0, handles: 0, credentials: 0 };
  for (const a of writes.accounts) {
    const consent = a.consent ? JSON.stringify(a.consent) : null;
    const rows = await q`INSERT INTO accounts (id, storage_key, webauthn_user_id, roles, plan, consent, origin)
      VALUES (${newAccountId()}, ${a.storageKey}, ${newWebauthnUserId()}, ARRAY['lifter'], 'free', ${consent}::jsonb, 'backfill')
      ON CONFLICT (storage_key) DO NOTHING RETURNING id`;
    inserted.accounts += rows.length;
  }
  for (const h of writes.handles) {
    const rows = await q`INSERT INTO handles (handle, account_id, display, kind, claimed_at)
      SELECT ${h.handle}, a.id, ${h.display}, 'primary', ${h.claimedAt} FROM accounts a WHERE a.storage_key = ${h.storageKey}
      ON CONFLICT (handle) WHERE released_at IS NULL DO NOTHING RETURNING id`;
    inserted.handles += rows.length;
  }
  for (const c of writes.credentials) {
    const rows = await q`INSERT INTO credentials (id, account_id, public_key, counter, transports, rp_id, user_handle, source, created_at)
      SELECT ${c.id}, a.id, ${c.publicKey}, ${c.counter}, ${JSON.stringify(c.transports)}::jsonb, ${c.rpId}, ${c.userHandle}, 'backfill', ${c.createdAt}
      FROM accounts a WHERE a.storage_key = ${c.storageKey}
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    inserted.credentials += rows.length;
  }

  console.log(backfillLogLine(plan, ` applied=${inserted.accounts}/${inserted.handles}/${inserted.credentials}`));
  return NextResponse.json({ applied: true, inserted });
}
