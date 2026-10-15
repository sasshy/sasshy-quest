import { readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inline classic scripts run immediately: defer has no effect without src.
// Keep the entry script after the root, even when Vite moves it into head.
export function inlineIOSDocument(html, readAsset) {
  const scripts = [];
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_, src) => {
    scripts.push(readAsset(src).replace(/<\/script/gi, '<\\/script'));
    return '';
  });
  if (scripts.length !== 1 || !html.includes('id="root"') || !html.includes('</body>')) {
    throw new Error('Expected one bundled entry and a root inside body');
  }
  html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
    (_, href) => `<style>${readAsset(href)}</style>`);
  return html.replace('</body>', () => `<script>${scripts[0]}</script>\n  </body>`);
}

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the iPhone project's SASSHYWeb folder is. Defaults to ios-web/ inside v2-src. */
export const iosTarget = resolve(project, process.env.SASSHY_IOS_WEB_DIR || 'ios-web');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(project, 'dist-ios');
  const html = inlineIOSDocument(readFileSync(resolve(dist, 'index.html'), 'utf8'), (src) => {
    const asset = resolve(dist, src);
    if (!asset.startsWith(dist + sep)) throw new Error('Asset outside dist');
    return readFileSync(asset, 'utf8');
  });
  mkdirSync(iosTarget, { recursive: true });
  rmSync(resolve(iosTarget, 'assets'), { recursive: true, force: true });
  cpSync(dist, iosTarget, { recursive: true });
  writeFileSync(resolve(iosTarget, 'app.html'), html);
  console.log(`Generated ${iosTarget}/app.html with entry after root`);
}
