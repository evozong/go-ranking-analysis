// Maps an OpenGotha <Game> `result` enum value to our normalized outcome.
// ADJUST HERE if a real file surfaces enum spellings not covered below.

export type ResultType =
  | 'game'
  | 'draw'
  | 'forfeit'
  | 'both_win'
  | 'both_lose'
  | 'bye'
  | 'no_result';

export type WinnerColor = 'white' | 'black' | null;

export interface Outcome {
  isGame: boolean;
  type: ResultType;
  winnerColor: WinnerColor;
  raw: string;
}

export function mapResult(rawInput: string | null | undefined): Outcome {
  const raw = (rawInput ?? '').trim();
  const key = raw.toUpperCase();

  switch (key) {
    case 'RESULT_WHITEWINS':
      return { isGame: true, type: 'game', winnerColor: 'white', raw };
    case 'RESULT_BLACKWINS':
      return { isGame: true, type: 'game', winnerColor: 'black', raw };
    case 'RESULT_EQUAL':
      return { isGame: true, type: 'draw', winnerColor: null, raw };

    case 'RESULT_WHITEWINS_BYDEF':
      return { isGame: false, type: 'forfeit', winnerColor: 'white', raw };
    case 'RESULT_BLACKWINS_BYDEF':
      return { isGame: false, type: 'forfeit', winnerColor: 'black', raw };

    case 'RESULT_BOTHLOSE':
    case 'RESULT_BOTHLOSE_BYDEF':
      return { isGame: false, type: 'both_lose', winnerColor: null, raw };

    case 'RESULT_BOTHWIN':
    case 'RESULT_BOTHWIN_BYDEF':
      return { isGame: false, type: 'both_win', winnerColor: null, raw };

    case 'RESULT_UNKNOWN':
    default:
      return { isGame: false, type: 'no_result', winnerColor: null, raw };
  }
}
