import type { ComparisonResult } from '../types';

/**
 * Lookups and comparisons asked for anywhere in the app, on their way to the search (components/GlobalSearch), which
 * runs them in its queue. The search loads after the first screen and an error can remount it, so a request made
 * while nothing listens waits here, with at most MAX_WAITING others (the oldest give way), and goes out when the
 * search subscribes. This module is in the app's first chunk: keep it this small.
 */

/** A lookup of a word, an expression or a typed text. */
export interface LookupRequest {
  query: string;
  /** 'text' was typed or pasted, so a sentence is scanned for its expressions; 'expression' was picked on screen (a
   *  tapped word, a term's button), so it is looked up as one entry however long it is. */
  source: 'text' | 'expression';
  /** Run the AI again even for a saved word, replacing its cards with the fresh result (a refresh). */
  forceAI?: boolean;
  /** The sentence the expression was picked from, shown above its meanings; never sent to the server or stored. */
  context?: string;
}

/** A comparison of two or more words, with its saved result when there is one. */
export interface CompareRequest {
  words: string[];
  cached: ComparisonResult | null;
}

/** What the search does with each kind of request. */
export interface SearchRequestHandlers {
  lookup: (request: LookupRequest) => void;
  compare: (request: CompareRequest) => void;
}

type Delivery = (handlers: SearchRequestHandlers) => void;

const MAX_WAITING = 20;
let current: SearchRequestHandlers | null = null;
let waiting: Delivery[] = [];

const send = (delivery: Delivery): void => {
  if (current) delivery(current);
  else if (waiting.push(delivery) > MAX_WAITING) waiting.shift();
};

/** Asks the search to look `request.query` up. */
export const requestLookup = (request: LookupRequest): void => send(handlers => handlers.lookup(request));

/** Asks the search to compare `request.words`, opening the saved result when there is one. */
export const requestCompare = (request: CompareRequest): void => send(handlers => handlers.compare(request));

/**
 * Hands every request to `handlers`, starting with the ones waiting, until the returned function is called. A later
 * subscriber takes over from an earlier one, whose unsubscribe then changes nothing.
 */
export function subscribeSearchRequests(handlers: SearchRequestHandlers): () => void {
  current = handlers;
  const delivered = waiting;
  waiting = [];
  delivered.forEach(delivery => delivery(handlers));
  return () => {
    if (current === handlers) current = null;
  };
}
