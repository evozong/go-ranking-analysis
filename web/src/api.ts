// Typed fetch helpers for the go-ranking-analysis API.

export interface ImportSummary {
  eventId: number;
  name: string;
  date: string | null;
  eventPlayers: number;
  playersCreated: number;
  playersMatched: number;
  gamesInserted: number;
  nonGames: number;
}

export interface PlayerListItem {
  id: number;
  name: string;
  gameCount: number;
  eventCount: number;
}

export interface OpponentRecord {
  opponentId: number;
  opponentName: string;
  wins: number;
  losses: number;
}

export interface PlayerEventRef {
  eventId: number;
  eventName: string;
  date: string | null;
  gameCount: number;
  wins: number;
}

export interface DuplicateHint {
  reason: 'egf' | 'name';
  playerIds: number[];
}

export interface MergeResult {
  keepId: number;
  keepName: string;
  mergedCount: number;
  movedEventPlayers: number;
}

export interface PlayerDetail {
  player: { id: number; name: string };
  events: PlayerEventRef[];
  losing: OpponentRecord[];
  even: OpponentRecord[];
  winning: OpponentRecord[];
}

export interface HistoryItem {
  eventId: number;
  eventName: string;
  date: string | null;
  roundNumber: number | null;
  opponentId: number | null;
  opponentName: string | null;
  outcome: 'win' | 'loss' | 'draw' | 'nongame';
  resultType: string;
}

export interface HistoryPage {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  items: HistoryItem[];
}

export interface EventListItem {
  id: number;
  name: string;
  date: string | null;
  gameCount: number;
  playerCount: number;
}

export interface EventPlayerRow {
  eventPlayerId: number;
  rawName: string;
  rank: string | null;
  canonicalPlayerId: number | null;
  canonicalName: string | null;
}

export interface MatchupRow {
  eventId: number;
  eventName: string;
  date: string | null;
  roundNumber: number | null;
  whiteName: string | null;
  blackName: string | null;
  winnerName: string | null;
  resultType: string;
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  importFile(file: File): Promise<ImportSummary> {
    const fd = new FormData();
    fd.append('file', file);
    return req<ImportSummary>('/api/imports', { method: 'POST', body: fd });
  },
  players: () => req<PlayerListItem[]>('/api/players'),
  playerDuplicateHints: () =>
    req<DuplicateHint[]>('/api/players/duplicate-hints'),
  mergePlayers: (keepId: number, mergeIds: number[]) =>
    req<MergeResult>('/api/players/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepId, mergeIds }),
    }),
  player: (id: number | string) => req<PlayerDetail>(`/api/players/${id}`),
  playerHistory: (id: number | string, page: number) =>
    req<HistoryPage>(`/api/players/${id}/history?page=${page}`),
  events: () => req<EventListItem[]>('/api/events'),
  event: (id: number | string) => req<EventListItem>(`/api/events/${id}`),
  eventPlayers: (id: number | string) =>
    req<EventPlayerRow[]>(`/api/events/${id}/players`),
  matchups: (params: { player?: number | string; event?: number | string }) => {
    const q = new URLSearchParams();
    if (params.player != null) q.set('player', String(params.player));
    if (params.event != null) q.set('event', String(params.event));
    return req<MatchupRow[]>(`/api/matchups?${q.toString()}`);
  },
  remapEventPlayer: (
    eventPlayerId: number | string,
    body: { playerId?: number; newName?: string },
  ) =>
    req<{ eventPlayerId: number; playerId: number; playerName: string }>(
      `/api/event-players/${eventPlayerId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
};
