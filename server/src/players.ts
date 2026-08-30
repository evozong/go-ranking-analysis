import type { Queryable } from './db.js';

// Canonical-name normalization: trim, collapse internal whitespace, lowercase.
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface ResolveResult {
  playerId: number;
  created: boolean;
}

// Match-or-create a canonical player for a raw "First Last" display name.
export async function resolveCanonicalPlayer(
  db: Queryable,
  displayName: string,
): Promise<ResolveResult> {
  const normalized = normalizeName(displayName);

  const existing = (
    await db.query('SELECT id FROM players WHERE normalized_name = $1', [normalized])
  ).rows[0] as { id: number } | undefined;

  if (existing) {
    return { playerId: existing.id, created: false };
  }

  const inserted = (
    await db.query(
      'INSERT INTO players (display_name, normalized_name) VALUES ($1, $2) RETURNING id',
      [displayName.trim(), normalized],
    )
  ).rows[0] as { id: number };

  return { playerId: inserted.id, created: true };
}
