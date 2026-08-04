// @ts-check
// lib/provenance.js
// ─────────────────────────────────────────────────────────────────────────────
// Provenance beacon — an INERT origin identifier, not an enforcement gate.
// It disables nothing, phones nothing home, and gates no feature. Its only
// job is attribution: the PolyForm Strict license (LICENSE) and NOTICE
// require this identifier to be retained in any copy. A fork that keeps it
// advertises this work's origin; a fork that strips it has removed a
// required notice — a provable licence breach, which is the point.
//
// DO NOT wire this into runtime behaviour. The moment app function depends
// on it, it becomes a covert kill-switch: legally hazardous, trivially
// removed from open source, and liable to brick honest local runs and
// contributors. The value here is evidentiary, not operational.
//
// The forensic registry (the specific dataset fingerprints that prove a
// copy independent of this beacon) lives OFF-repo, in the internal notes —
// deliberately, so a copyist can't read the tell from the public source.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVENANCE = Object.freeze({
  work: "Heatwayve",
  codename: "Forge",
  origin: "heatwayve.app",
  repository: "github.com/wondabrar/project-forge",
  license: "PolyForm-Strict-1.0.0",
  holder: "abraraaa <abrar.a@outlook.com>",
  // The relying-party id is domain-bound by WebAuthn and is permanent
  // internal infrastructure (see docs/moat.md): a client on any other
  // origin cannot mint or verify a passkey against it. Named here so the
  // dependency is a documented architectural stance, not an accident.
  rpId: "theforged.fit",
});
