/**
 * Utility for formatting Content-Disposition headers according to RFC 6266 and RFC 5987.
 *
 * Supports non-ASCII (e.g. Arabic) filenames with:
 * - Safe ASCII fallback parameter in `filename="..."` (preserving original extension).
 * - Standard RFC 5987 percent-encoded UTF-8 filename in `filename*=UTF-8''...`.
 *
 * Strictly avoids putting raw percent-encoded text into the ASCII filename parameter,
 * preventing double-encoding and mojibake in clients that only read the ASCII parameter.
 */
export function buildContentDisposition(filename: string): string {
  const cleanName = (filename || 'document')
    .replace(/[\r\n\t\x00-\x1F]/g, ' ')
    .trim() || 'document';

  // Extract file extension (e.g., '.pdf')
  const lastDot = cleanName.lastIndexOf('.');
  const ext = lastDot > 0 ? cleanName.slice(lastDot).replace(/[^\w.]/g, '').toLowerCase() : '';

  // Safe ASCII fallback: only printable ASCII (0x20 - 0x7E), stripping quotes and backslashes
  const asciiBase = cleanName
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '_')
    .trim();

  // Strip extension from asciiBase to evaluate base content
  const baseWithoutExt = ext && asciiBase.toLowerCase().endsWith(ext)
    ? asciiBase.slice(0, -ext.length).trim()
    : asciiBase.replace(/\.[a-zA-Z0-9]+$/, '').trim();

  // If asciiBase has no alphanumeric characters (e.g. purely Arabic or punctuation), fall back to 'document'
  const hasAlphaNum = /[a-zA-Z0-9]/.test(baseWithoutExt);
  const safeAscii = (hasAlphaNum ? `${baseWithoutExt}${ext}` : `document${ext}`) || 'document';

  // Strict RFC 5987 UTF-8 percent-encoding:
  // encodeURIComponent percent-encodes all characters except: A-Z a-z 0-9 - _ . ! ~ * ' ( )
  // RFC 5987 attr-char forbids: ' ( ) *
  // We explicitly percent-encode ' ( ) * so all attr-chars are valid.
  const encodedUtf8 = encodeURIComponent(cleanName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
