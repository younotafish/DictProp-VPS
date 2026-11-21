// Stand-ins for the tests that run the theme sweep: the AI provider its chat client asks, and a clock the test moves.
import { createChatClient } from '../../src/ai-client.js';
import type { FetchLike } from '../../src/proxy-fetch.js';
import { THEMES } from '../../src/shared/item-themes.js';
import { reply, type Responder } from './ai.js';

const [A] = THEMES.map(theme => theme.id);

/**
 * DeepInfra as the sweep's chat client meets it: `respond` answers each request from the sentences it asks about, by
 * default giving each sentence the theme `scene(text)` returns (none for null).
 */
export function provider(respond: (texts: string[]) => Responder | Promise<Responder>) {
  const asked: string[][] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const texts = [...body.messages[1].content.matchAll(/^\d+\. sentence "(.*)"$/gm)].map(match => match[1]);
    asked.push(texts);
    return (await respond(texts))(init);
  };
  return { chat: createChatClient({ fetch, apiKey: () => 'test-key', retryDelayMs: 0 }), asked };
}

export const answering = (scene: (text: string) => string | null = () => A) => (texts: string[]) =>
  reply({ a: texts.flatMap((text, index) => (scene(text) ? [{ i: index + 1, t: scene(text) }] : [])) });

/** A clock the test moves: timers run when it passes them. */
export function manualClock(start = 1_000_000) {
  let time = start;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: time + ms, run, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    advance(ms: number) {
      time += ms;
      for (const timer of timers.filter(entry => entry.live && entry.at <= time)) {
        timer.live = false;
        timer.run();
      }
    },
    liveTimers: () => timers.filter(timer => timer.live).length,
  };
}
