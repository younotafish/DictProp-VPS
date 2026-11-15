import type { RawEssayCatalog } from '../essayCatalog';
import { requestJson } from '../http';

// The private essay catalog, which the server keeps out of the public bundle.

export const loadPrivateEssayCatalog = async (): Promise<RawEssayCatalog> =>
  requestJson<RawEssayCatalog>('/api/essays/catalog', undefined, 'Load private essay catalog');
