/** Thin seam over UUID generation for testability + future swap. */
export function generateUuid(): string {
  return crypto.randomUUID();
}
