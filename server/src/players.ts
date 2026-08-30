import type { Database } from 'better-sqlite3';

// Canonical-name normalization: trim, collapse internal whitespace, lowercase.
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface ResolveResult {
  playerId: number;
  created: boolean;
}

// Match-or-create a canonical player for a raw "First Last" display name.
export function resolveCanonicalPlayer(db: Database, displayName: string): ResolveResult {
  const normalized = normalizeName(displayName);

  const existing = db
    .prepare('SELECT id FROM players WHERE normalized_name = ?')
    .get(normalized) as { id: number } | undefined;

  if (existing) {
    return { playerId: existing.id, created: false };
  }

  const info = db
    .prepare('INSERT INTO players (display_name, normalized_name) VALUES (?, ?)')
    .run(displayName.trim(), normalized);

  return { playerId: Number(info.lastInsertRowid), created: true };
}
