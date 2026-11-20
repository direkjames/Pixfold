import { defineConfig, type Plugin } from 'vite';

// The built page may load only its own files. (GitHub Pages cannot send headers, so this is a meta tag.
// Skipped in dev, where Vite needs inline scripts and a socket for hot reload.)
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const csp: Plugin = {
  name: 'pixfold-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta name="viewport"', `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="viewport"`),
};

// Relative paths, so the built app works at any address (the site root or a sub-folder like /Pixfold/).
// assetsInlineLimit 0 keeps the small fonts as files: the policy above blocks data: URLs.
export default defineConfig({ base: './', plugins: [csp], build: { assetsInlineLimit: 0 } });
