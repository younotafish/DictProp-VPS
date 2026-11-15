import { useEffect, useRef } from 'react';
import { isPhraseItem, type StoredItem } from '../types';
import { IMAGE_IDB_MARKER, getServerImageVersion } from '../services/libraryImages';
import { decodeImage, warmImage } from '../services/storage';

type LoadMissingImage = (itemId: string, imageVersion?: string) => Promise<string | null>;

/** The pictures a card shows: its own, and those of the words inside a phrase. */
export const picturesOf = (item: StoredItem): Array<{ id: string; imageUrl: string | undefined }> => [
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
          // Stored on this device, or on the server at a version; the bare legacy server marker isn't warmed.
          const version = getServerImageVersion(imageUrl);
          if (imageUrl !== IMAGE_IDB_MARKER && version === undefined) continue;
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
