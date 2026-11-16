/**
 * Items deleted on another device, as the open card view meets them: the writes the view makes on its own must not
 * bring them back.
 */

/**
 * How the view writes a change it makes on its own to a sentence, such as the voice a listen leaves: 'patch' its live
 * record (onPatchItem, which leaves a deleted item alone); 'create' the record of a Real Life or essay line that has
 * none yet, as its first listen always has; or 'skip' a sentence the library doesn't hold, whether it was deleted
 * on another device or is an unsaved example.
 */
export function automaticWrite({ live, catalogLine }: { live: boolean; catalogLine: boolean }): 'patch' | 'create' | 'skip' {
  if (live) return 'patch';
  return catalogLine ? 'create' : 'skip';
}
