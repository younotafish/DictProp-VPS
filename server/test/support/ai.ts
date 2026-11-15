// Stand-ins for DeepInfra's chat API, for the tests that inject a fetch into the AI client or routes.

/** One scripted answer to a request. */
export type Responder = (init: RequestInit) => Response | Promise<Response>;

/** A chat completion whose message is `content` (JSON-encoded unless it's a string). */
export const reply = (content: unknown, finishReason = 'stop') => () => new Response(JSON.stringify({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }],
}));

/** A bare HTTP status, as a failing provider sends. */
export const httpStatus = (code: number, body = '') => () => new Response(body, { status: code });

/** Never answers; rejects with the signal's reason, like fetch does. */
export const hang: Responder = (init) => new Promise<Response>((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/** AbortSignal.timeout timers do not keep the process alive; this holds it open while a test waits on one. */
export async function keepingAlive<T>(run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}
