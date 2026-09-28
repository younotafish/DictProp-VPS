import { useEffect, useRef } from 'react';
import { isPhraseItem, type StoredItem } from '../types';
import { decodeImage, warmImage } from '../services/storage';

type LoadMissingImage = (itemId: string, imageVersion?: string) => Promise<string | null>;

/** The pictures a card shows: its own, and those of the words inside a phrase. */
const picturesOf = (item: StoredItem) => [
  { id: item.data.id, imageUrl: item.data.imageUrl },
  ...(isPhraseItem(item) ? (item.data.vocabs ?? []).map(vocab => ({ id: vocab.id, imageUrl: vocab.imageUrl })) : []),
];

/**
 * Decodes the pictures of the cards the learner can move to next, downloading any that aren't stored yet,
 * so moving to one of those cards paints its picture on the first frame. `items` is in priority order.
 */
export function useWarmImages(items: readonly StoredItem[], loadMissing?: LoadMissingImage) {
  // Downloads already asked for, so a picture the server doesn't have isn't requested on every move.
  const requestedRef = useRef(new Set<string>());

  useEffect(() => {
    if (items.length === 0) return;
    const requested = requestedRef.current;

    const warm = () => {
      for (const item of items) {
        for (const { id, imageUrl } of picturesOf(item)) {
          if (!imageUrl || imageUrl.startsWith('data:image/')) continue;
          if (imageUrl.startsWith('/api/')) {
            void decodeImage(imageUrl);
            continue;
          }
          if (imageUrl !== 'idb:stored' && !imageUrl.startsWith('server:has_image:')) continue;
          const version = imageUrl.startsWith('server:has_image:') ? imageUrl.slice('server:has_image:'.length) : undefined;
          const key = `${id}\n${version ?? ''}`;
          void warmImage(id, version).then(async stored => {
            if (stored || !loadMissing || requested.has(key)) return;
            requested.add(key);
            try {
              if (await loadMissing(id, version)) await warmImage(id, version);
            } catch {
              requested.delete(key); // a transient failure is retried on the next move or reconnect
            }
          });
        }
      }
    };

    warm();
    window.addEventListener('online', warm);
    return () => window.removeEventListener('online', warm);
  }, [items, loadMissing]);
}
