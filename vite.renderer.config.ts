import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { PRODUCTION_CSP } from './src/shared/csp';

// The packaged app loads index.html over file://, where response-header CSP is not reliable,
// so the production build also carries the policy in a <meta> tag. Dev keeps no CSP because
// Vite's HMR needs inline scripts and a websocket.
function productionCsp(): Plugin {
  return {
    name: 'backup-hub-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), productionCsp()],
});
