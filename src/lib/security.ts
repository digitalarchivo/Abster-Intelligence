import DOMPurify from 'isomorphic-dompurify';

// Anti-tabnabbing: force every anchor that survives sanitization to open in a
// new tab WITHOUT window.opener access. Applies to chat markdown, reports and
// any other surface routed through sanitizeMarkdown.
if (typeof (DOMPurify as any).addHook === 'function') {
  (DOMPurify as any).addHook('afterSanitizeAttributes', (node: any) => {
    if (node?.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * DOMPurify keeps allowlisted `style` attribute CONTENT mostly verbatim —
 * it does not deeply validate CSS function tokens. Modern browsers no longer
 * execute `url(javascript:)` in CSS, but as defense-in-depth we scrub the
 * classic dangerous CSS constructs from every style attribute after
 * sanitization. Our own generated styles never contain these tokens, so only
 * injected content is affected.
 */
const DANGEROUS_CSS = /(javascript|vbscript|behavior|-moz-binding)\s*:|expression\s*\(|data\s*:\s*text\/html/gi;

function scrubStyleAttributes(html: string): string {
  return html.replace(/style\s*=\s*(["'])([^"']*)\1/gi, (_m, quote: string, css: string) => {
    const clean = css.replace(DANGEROUS_CSS, '');
    return clean === css ? _m : `style=${quote}${clean}${quote}`;
  });
}

export function sanitizeMarkdown(rawString: string): string {
  if (!rawString) return '';
  const sanitized = DOMPurify.sanitize(rawString, {
    // `details`/`summary` are required by the chat renderer: the collapsible
    // reasoning panel emitted by src/lib/markdown.ts depends on them.
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
      'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
      'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'span',
      'details', 'summary',
    ],
    // `style` + `open` are emitted by src/lib/markdown.ts itself; the content
    // is additionally scrubbed by scrubStyleAttributes below.
    ALLOWED_ATTR: ['href', 'name', 'target', 'class', 'style', 'open'],
  });
  return scrubStyleAttributes(sanitized);
}
