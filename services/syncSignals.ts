const CHANNEL_NAME = 'dictprop-sync-v2';

let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;
  return channel;
}

export function publishServerMutation(): void {
  getChannel()?.postMessage({ type: 'server-mutation', at: Date.now() });
}

export function subscribeToServerMutations(callback: () => void): () => void {
  const current = getChannel();
  if (!current) return () => undefined;
  const listener = (event: MessageEvent) => {
    if (event.data?.type === 'server-mutation') callback();
  };
  current.addEventListener('message', listener);
  return () => current.removeEventListener('message', listener);
}
