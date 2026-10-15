import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// iPhone app build (`vite build --mode ios`): WKWebView blocks ES module scripts
// loaded directly from file:// URLs. Vite emits a self-contained bundle, so load
// it as a deferred classic script; scripts/bundle-ios.mjs then inlines it.
const iosClassicScript: Plugin = {
  name: 'sasshy-ios-classic-script',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      return html
        .replace(
          /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
          '<script defer src="$1"></script>',
        )
        .replace(
          /<link rel="stylesheet" crossorigin href="([^"]+)">/g,
          '<link rel="stylesheet" href="$1">',
        );
    },
  },
};

export default defineConfig(({ mode }) => ({
  plugins: mode === 'ios' ? [react(), iosClassicScript] : [react()],
  base: './',
  build: {
    outDir: mode === 'ios' ? 'dist-ios' : 'dist',
    sourcemap: true,
  },
}));
