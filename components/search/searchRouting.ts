import type { LookupRequest } from '../../services/searchRequests';

/** How a lookup runs. */
export type LookupRoute =
  /** Refused: it needs the network, and the device is offline. */
  | { kind: 'offline' }
  /** A typed sentence: scanned for its uncommon expressions, each of which is then looked up. */
  | { kind: 'scan' }
  /** Analyzed by the AI, unless the library answers first: as one entry ('batch'), and with forceAI as a refresh that
   *  runs the AI even for a saved word. */
  | { kind: 'analyze'; analyzeMode?: 'batch'; forceAI: boolean };

/** What the routing needs to know about a lookup's query and the device. */
export interface LookupFacts {
  online: boolean;
  /** The library has cards for the query, so it opens without the network. */
  saved: boolean;
  /** The query reads as a sentence (server/src/shared/query-mode's looksLikeSentence). */
  sentence: boolean;
}

/**
 * How a lookup runs, decided the same way wherever it was asked for. A refresh always asks the AI. A typed sentence is
 * scanned; a sentence picked on screen (a long marked term) is one expression, analyzed as one entry, as the card's
 * own sense lookup does; anything else, a word or a short phrase, is analyzed as it is. Offline, only what needs no
 * network goes ahead: a saved word or expression opens, and anything else is refused, a scan included.
 */
export function routeLookup(request: Pick<LookupRequest, 'source' | 'forceAI'>, { online, saved, sentence }: LookupFacts): LookupRoute {
  if (request.forceAI) return { kind: 'analyze', forceAI: true };
  const scan = sentence && request.source === 'text';
  if (!online && (scan || !saved)) return { kind: 'offline' };
  if (scan) return { kind: 'scan' };
  return sentence ? { kind: 'analyze', analyzeMode: 'batch', forceAI: false } : { kind: 'analyze', forceAI: false };
}
