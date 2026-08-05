/**
 * Content-Type / Content-Disposition decision for the public `/public/:token`
 * media route (LINE image delivery today). This route is about to be exposed on a
 * public origin, so it is a stored-XSS surface: an agent can write ANY file under
 * its own media root, and once a signed token is minted the file is served from the
 * gateway origin. `res.sendFile` derives Content-Type from the file extension, so a
 * `.svg` (image/svg+xml) or `.html` file would execute script on our origin —
 * `X-Content-Type-Options: nosniff` does NOT neutralize a correctly-typed
 * executable resource.
 *
 * Defence: allow ONLY true raster image types to be served inline with an explicit
 * safe Content-Type (these cannot execute script); force EVERYTHING else — svg,
 * html, xml, unknown — to a non-executable `application/octet-stream` download.
 */

/** Raster image extensions safe to serve inline → their explicit Content-Type. */
const INLINE_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export type SafeMediaHeaders = {
  /** Explicit Content-Type to set BEFORE sendFile so it wins over inference. */
  contentType: string;
  /** When present, force a download (non-inline, non-executable). */
  disposition?: string;
};

/**
 * Strip characters that could break out of the quoted `filename="..."` in a
 * Content-Disposition header (quotes, backslashes, control chars incl. CR/LF).
 * The basename is agent-controlled, so this also closes a header-injection vector.
 */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/["\\\r\n\x00-\x1f]/g, '');
  return cleaned.length > 0 ? cleaned : 'download';
}

/**
 * Decide how to serve a media file by its extension.
 * - Raster image (allowlist) → inline with an explicit safe Content-Type.
 * - Anything else (svg/html/htm/xml/unknown) → forced download as octet-stream.
 *
 * @param ext      file extension INCLUDING the dot (e.g. ".png"); case-insensitive.
 * @param basename file basename, used only for the download filename.
 */
export function safeMediaHeaders(ext: string, basename: string): SafeMediaHeaders {
  const inline = INLINE_IMAGE_TYPES[ext.toLowerCase()];
  if (inline) {
    return { contentType: inline };
  }
  return {
    contentType: 'application/octet-stream',
    disposition: `attachment; filename="${sanitizeFilename(basename)}"`,
  };
}
