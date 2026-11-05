/**
 * Deterministic Arabic-aware alphabetical sorting for items across QuarryVault.
 * Collation handles Arabic letters (including alif variants, hamza, taa marbuta)
 * and English letters in natural alphabetical order with numeric support.
 */
export function sortAlphabetically<T>(items: T[], keyFn: (item: T) => string): T[] {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const keyA = (keyFn(a) || '').trim();
    const keyB = (keyFn(b) || '').trim();
    return keyA.localeCompare(keyB, ['ar', 'en'], { sensitivity: 'base', numeric: true });
  });
}
