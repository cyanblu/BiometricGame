// Builds dist/biometric.html: one self-contained page (no ES module imports),
// in the shape the claude.ai Artifact viewer expects (no doctype/html/head/body).
// Modules are concatenated in dependency order; import lines and `export`
// keywords are stripped, so top-level names must stay unique across files.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ORDER = ['src/sim.js', 'src/levels.js', 'src/characters.js', 'src/dynamics.js', 'src/bug.js', 'src/pixel.js', 'src/vitals.js', 'src/render.js', 'src/audio.js', 'src/main.js'];

const js = ORDER.map((f) => {
  const raw = readFileSync(f, 'utf8');
  // Imports are deleted, not resolved, so a renamed import would vanish.
  const alias = raw.match(/^import[^;]*\bas\b[^;]*;/m);
  if (alias) throw new Error(`${f}: import aliases are not supported by this bundler: ${alias[0]}`);
  const src = raw
    .replace(/^import[^;]+;\n/gm, '')
    .replace(/^export (const|function|let|class) /gm, '$1 ');
  return `// ---- ${f}\n${src}`;
}).join('\n');

const html = readFileSync('index.html', 'utf8');
const page = html.slice(html.indexOf('<!-- page:start -->') + 19, html.indexOf('<!-- page:end -->'))
  .replace('</head>\n<body>\n', '')
  .replace('<script type="module" src="src/main.js"></script>', `<script>\n(() => {\n${js}\n})();\n</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/biometric.html', page.trim() + '\n');
console.log(`dist/biometric.html: ${page.length} bytes`);
