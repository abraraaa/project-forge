// One rule for turning a profile name into its storage key, shared by every
// route. NFKC first so look-alike codepoints (fullwidth letters, the Kelvin
// sign, decomposed accents) land on one key: the name IS the identity, and a
// route that keyed differently could miss data on delete.
// Census 2026-09-24: every stored key already equals its NFKC form, so
// adopting this everywhere moved nothing.

/** @param {unknown} name */
export const normaliseProfile = (name) => String(name || "").normalize("NFKC").trim().toLowerCase();
