/** The SHA-256 of `data`, as lowercase hex. WebCrypto, so only on a secure origin (https or localhost). */
export const sha256Hex = async (data: BufferSource): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};
