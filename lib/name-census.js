// Name-key census — pure. The sync route keys profiles on NFKC+lowercase;
// photos, auth and credentials key on lowercase only. For most names the two
// agree. This finds the stored keys where they don't: the keys that would
// move if every route shared one normaliser. Read-only by construction.

/** The canonical key (the sync route's rule). */
export const canonicalName = (name) => String(name || "").normalize("NFKC").trim().toLowerCase();

/**
 * @param {{ source: string, key: string }[]} entries  raw stored keys by source
 * @returns {{ scanned: number, distinct: number, divergent: { key: string, canonical: string, sources: string[] }[] }}
 */
export function censusNameKeys(entries) {
  /** @type {Map<string, Set<string>>} */
  const byKey = new Map();
  for (const { source, key } of entries) {
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(source);
  }
  const divergent = [];
  for (const [key, sources] of byKey) {
    const canonical = canonicalName(key);
    if (canonical !== key) divergent.push({ key, canonical, sources: [...sources].sort() });
  }
  divergent.sort((a, b) => a.canonical.localeCompare(b.canonical));
  return { scanned: entries.length, distinct: byKey.size, divergent };
}
