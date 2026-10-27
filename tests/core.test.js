/**
 * Project checks for a standalone app.js with the website at the root or in site/.
 * Run from the project folder: npm test
 * Tests inspect files, syntax, DOM references and research-data consistency.
 * Browser rendering and user interactions must also be checked in a real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(path, 'utf8');
// Asset URLs resolve relative to the actual HTML document, not the tests folder.
// An explicit directory can be supplied if a repository contains two entry pages.
const candidates = process.env.EXPLORER_SITE_DIR
  ? [resolve(projectRoot, process.env.EXPLORER_SITE_DIR)]
  : [projectRoot, resolve(projectRoot, 'site')];
const available = candidates.filter(path => existsSync(resolve(path, 'index.html')));
const hasIndex = available.length === 1;
const root = hasIndex ? available[0] : projectRoot;
const indexPath = resolve(root, 'index.html');
const html = hasIndex ? read(indexPath) : '';
const needsIndex = { skip: hasIndex ? false : 'Primero hay que localizar un único index.html.' };

function attribute(tag, name) {
  const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'i'));
  return match?.[2] ?? '';
}

function localAsset(reference) {
  assert.ok(reference, 'Falta la ruta de un recurso en index.html.');
  assert.ok(!/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(reference),
    `Usa una ruta relativa al proyecto: ${reference}`);
  const path = resolve(root, decodeURIComponent(reference.split(/[?#]/)[0]));
  const inside = relative(root, path);
  assert.ok(!inside.startsWith('..') && !isAbsolute(inside), `El recurso sale de la carpeta del proyecto: ${reference}`);
  assert.ok(existsSync(path), `No existe el archivo indicado en index.html: ${reference}`);
  return path;
}

function scripts() {
  return [...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi)]
    .map(match => ({ src: attribute(match[1], 'src'), type: attribute(match[1], 'type') }))
    .filter(script => script.src && !/json/i.test(script.type));
}

function sources() {
  return scripts().map(script => read(localAsset(script.src)));
}

function corpus() {
  // Both stages of the manual separation are supported.
  const embedded = html.match(/<script\b(?=[^>]*\bid\s*=\s*["']dataset["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (embedded) return JSON.parse(embedded[1]);
  const code = sources().join('\n');
  const external = code.match(/\bfetch\s*\(\s*['"]([^'"]+\.json(?:\?[^'"]*)?)['"]/);
  assert.ok(external,
    'No se encuentra el bloque dataset ni una carga fetch("./data/corpus.json") en app.js.');
  return JSON.parse(read(localAsset(external[1])));
}

const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
const idSet = new Set(ids);

test('index.html exists and contains the map and the four research sections', () => {
  assert.equal(available.length, 1, available.length > 1
    ? 'Hay más de un index.html. Indica la carpeta publicada con EXPLORER_SITE_DIR=site npm test (o EXPLORER_SITE_DIR=. npm test).'
    : `No se encuentra index.html. Carpetas comprobadas: ${candidates.join(', ')}.`);
  for (const id of ['top', 'map', 'explore', 'publications', 'evaluation', 'methods']) {
    assert.ok(idSet.has(id), `Falta el elemento con id="${id}".`);
  }
  assert.equal(ids.length, idSet.size, 'Hay identificadores HTML duplicados.');
});

test('the stylesheets linked from index.html exist and contain CSS', needsIndex, () => {
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => attribute(tag, 'rel').split(/\s+/).includes('stylesheet'));
  assert.ok(styles.length > 0, 'Falta el enlace a styles.css.');
  for (const tag of styles) {
    const css = read(localAsset(attribute(tag, 'href')));
    assert.ok(css.trim().length > 0, 'El archivo CSS está vacío.');
    assert.ok(!/<\/?style\b/i.test(css), 'El archivo CSS no debe incluir las etiquetas <style> ni </style>.');
  }
});

test('external JavaScript files exist and pass Node syntax checking', needsIndex, () => {
  const files = scripts();
  assert.ok(files.length > 0, 'Falta el enlace a app.js.');
  for (const script of files) {
    const path = localAsset(script.src);
    const code = read(path);
    assert.ok(code.trim().length > 0, `El JavaScript está vacío: ${script.src}`);
    assert.ok(!/<\/?script\b/i.test(code), `Retira las etiquetas <script> de ${script.src}.`);
    // Use the same Node executable that is running the tests, independent of PATH.
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr || check.error?.message || `Error de sintaxis en ${script.src}.`);
  }
});

test('literal JavaScript references point to existing HTML elements', needsIndex, () => {
  for (const code of sources()) {
    const references = [...code.matchAll(/(?:\$|document\.getElementById)\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const match of references) {
      assert.ok(idSet.has(match[1]), `JavaScript busca id="${match[1]}" y no existe en el HTML.`);
    }
  }
});

test('the configured research corpus loads as JSON and contains records', needsIndex, () => {
  const data = corpus();
  assert.ok(Array.isArray(data.docs) && data.docs.length > 0, 'El corpus no contiene artículos en docs.');
  assert.ok(data.provenance?.coordinate_sha256, 'Falta la huella de las coordenadas.');
});

test('mapped articles have unique PMIDs and valid coordinates', needsIndex, () => {
  const records = corpus().docs;
  const pmids = new Set();
  for (const record of records) {
    assert.ok(record.PMID, 'Hay un artículo sin PMID.');
    assert.ok(!pmids.has(String(record.PMID)), `PMID duplicado: ${record.PMID}`);
    pmids.add(String(record.PMID));
    assert.equal(typeof record.Title, 'string', `Título inválido: ${record.PMID}`);
    for (const key of ['UMAP1', 'UMAP2']) {
      assert.ok(record[key] !== null && record[key] !== '' && Number.isFinite(Number(record[key])),
        `Coordenada ${key} inválida para PMID ${record.PMID}.`);
    }
  }
});

test('each clustering solution contains one assignment per mapped article', needsIndex, () => {
  const data = corpus();
  assert.ok(data.solutions?.['leiden_r0.5'], 'Falta la solución principal leiden_r0.5.');
  for (const [name, solution] of Object.entries(data.solutions)) {
    assert.ok(Array.isArray(solution.labels), `Faltan las asignaciones de ${name}.`);
    assert.equal(solution.labels.length, data.docs.length, `Número de asignaciones incorrecto en ${name}.`);
  }
});

test('mapped parent groups and subtopics have defined names', needsIndex, () => {
  const data = corpus();
  assert.ok(data.names?.parent_names && data.names.subtopic_names, 'Faltan los nombres de grupos o subtemas.');
  for (const record of data.docs) {
    assert.ok(Object.hasOwn(data.names.parent_names, String(record.parent_group)), `Grupo sin nombre: ${record.parent_group}`);
    if (record.subtopic_id) {
      assert.ok(Object.hasOwn(data.names.subtopic_names, record.subtopic_id), `Subtema sin nombre: ${record.subtopic_id}`);
    }
  }
});
