// The bulk JSON import, which adds items (and fetches their remote pictures) on the server.

export const importJSON = async (
  items: any[],
): Promise<{ ok: boolean; imported: number; skipped: number; imagesFetched: number }> => {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `Import failed: ${res.status}`);
  }
  return res.json();
};
