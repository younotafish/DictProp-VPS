/**
 * A write that conflicts with what the server holds: an id another user owns, or an undo that a later change to
 * the item has overtaken. app.ts answers it with 409 and the message.
 */
export class ConflictError extends Error {
  name = 'ConflictError';
}
