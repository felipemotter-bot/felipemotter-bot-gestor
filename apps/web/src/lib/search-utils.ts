/**
 * Escape special characters for PostgreSQL ILIKE patterns.
 * `%` and `_` are wildcards in LIKE/ILIKE; `\` is the escape char.
 */
export function escapeIlikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build a Supabase PostgREST `.or()` filter string for searching
 * transactions by description or original_description.
 *
 * Returns `null` when the search term is empty (no filter needed).
 */
export function buildTransactionSearchFilter(search: string): string | null {
  const trimmed = search.trim().toLowerCase();
  if (!trimmed) return null;

  const escaped = escapeIlikePattern(trimmed);
  const pattern = `%${escaped}%`;
  return `description.ilike.${pattern},original_description.ilike.${pattern}`;
}
