#!/usr/bin/env node
// Generates a browsable copy of the popup with a stubbed chrome API, so the
// interface can be inspected without loading the extension.
//
// Generated rather than hand-maintained: a second copy of popup.html would
// drift from the real one within a day, and then the visual pass would be
// verifying a page nobody ships. Lives under .claude/tmp/ so it never ends up
// inside the packaged extension.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.claude/tmp/preview');

mkdirSync(outDir, { recursive: true });

let html = readFileSync(resolve(root, 'src/popup.html'), 'utf8');

// Repoint assets at the real source files: one source of truth for CSS and JS.
html = html
  .replace('href="popup.css"', 'href="../../../src/popup.css"')
  .replace('src="../icons/icon48.png"', 'src="../../../icons/icon48.png"')
  .replace(
    '<script type="module" src="popup.js"></script>',
    '<script src="fixtures.js"></script>\n    <script type="module" src="../../../src/popup.js"></script>'
  );

// A scenario switcher, so every state is one click away instead of a code edit.
html = html.replace(
  '</body>',
  `  <div id="preview-bar">
      <a href="?scenario=list">list</a>
      <a href="?scenario=mixed">mixed</a>
      <a href="?scenario=empty">empty</a>
      <a href="?scenario=onboarding">onboarding</a>
      <a href="?scenario=error">error</a>
      <a href="?scenario=ratelimit">rate limit</a>
      <a href="?scenario=loading">loading</a>
    </div>
    <style>
      body { height: auto; }
      #preview-bar {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 99;
        display: flex; gap: 10px; justify-content: center;
        padding: 6px; font: 500 10px var(--font);
        background: var(--surface); border-top: 1px solid var(--hairline-color);
      }
      #preview-bar a { color: var(--text-secondary); }
      .app { height: 580px; }
    </style>
  </body>`
);

writeFileSync(resolve(outDir, 'preview.html'), html);
copyFileSync(resolve(root, 'tools/preview-fixtures.js'), resolve(outDir, 'fixtures.js'));
console.log(`wrote ${resolve(outDir, 'preview.html')}`);

/* ------------------------------------------------------- the shortcut page */

// Same treatment for resolve.html. It is only ever reached by the service
// worker navigating a tab to it, so without this there is no way to look at it
// at all short of typing a shortcut URL and hoping it misses.
let sheet = readFileSync(resolve(root, 'src/resolve.html'), 'utf8');

sheet = sheet
  .replace('href="popup.css"', 'href="../../../src/popup.css"')
  .replace('href="resolve.css"', 'href="../../../src/resolve.css"')
  .replace('src="../icons/icon128.png"', 'src="../../../icons/icon128.png"')
  .replace(
    '<script type="module" src="resolve-page.js"></script>',
    // Module scripts run in document order, so the stub is installed before the
    // page asks `chrome` anything.
    '<script type="module" src="resolve-stub.mjs"></script>\n' +
      '    <script type="module" src="../../../src/resolve-page.js"></script>'
  );

sheet = sheet.replace(
  '</body>',
  `  <div id="preview-bar">
      <a href="?q=abv-4242">one match</a>
      <a href="?q=abv-42">partial → chooser</a>
      <a href="?q=above%236081">repo#number</a>
      <a href="?q=abv-0000">no match</a>
      <a href="?q=">everything</a>
      <a href="?scenario=nothing-open&amp;q=abv-4242">nothing open</a>
      <a href="?scenario=noToken&amp;q=abv-4242">no token</a>
      <a href="?scenario=error&amp;q=abv-4242">error</a>
    </div>
    <style>
      #preview-bar {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 99;
        display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
        padding: 6px; font: 500 10px var(--font);
        background: var(--surface); border-top: 1px solid var(--hairline-color);
      }
      #preview-bar a { color: var(--text-secondary); }
    </style>
  </body>`
);

writeFileSync(resolve(outDir, 'resolve.html'), sheet);
copyFileSync(resolve(root, 'tools/preview-resolve.mjs'), resolve(outDir, 'resolve-stub.mjs'));
console.log(`wrote ${resolve(outDir, 'resolve.html')}`);
