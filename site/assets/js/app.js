/**
 * Bioinformatics in Spain — browser application for the research explorer.
 *
 * Loaded as a classic deferred script: no bundler or additional runtime modules.
 * The corpus is fetched once; filtering, review storage and exports run locally.
 * Original coordinates, assignments and quantitative results are never rewritten.
 * Keep HTML IDs, export schemas and the existing review storage key compatible.
 */
(async () => {
  'use strict';

  // Application defaults and limits shared by UI handlers and import validation.
  const DEFAULT_SOLUTION = 'leiden_r0.5';
  const PAGE_SIZE = 50;
  const SEARCH_DEBOUNCE_MS = 120;
  const TOAST_DURATION_MS = 4500;
  const DOWNLOAD_URL_LIFETIME_MS = 1500;
  const REVIEW_NAME_LIMIT = 250;
  const REVIEW_NOTES_LIMIT = 10000;
  const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024;
  const REVIEW_FORMAT = 'biomedbert-topic-reviews';
  const REVIEW_VERSION = 1;

  /** Look up the stable element IDs shared with index.html. */
  const $ = id => document.getElementById(id);

  /** Escape text before inserting corpus or review values into HTML and SVG. */
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const formatNumber = value => Number(value).toLocaleString('en-GB');
  const pubmedURL = pmid => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

  /**
   * Load the external corpus relative to the HTML document, including on GitHub Pages.
   * Fail before event registration if essential records or provenance are missing.
   * @returns {Promise<object>} Parsed research data; source arrays remain untouched.
   */

  async function loadCorpus() {
    const response = await fetch('./data/corpus.json');
    if (!response.ok) {
      throw new Error(`Unable to load the research dataset (HTTP ${response.status}).`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.docs) || !data.docs.length
        || !data.solutions?.[DEFAULT_SOLUTION]
        || !data.provenance?.coordinate_sha256) {
      throw new Error('Missing required corpus data or coordinate fingerprint.');
    }
    return data;
  }

  function showError(message, error) {
    $('appError').textContent = message;
    $('appError').hidden = false;
    if (error) console.error(error);
  }

  let corpus;
  try {
    corpus = await loadCorpus();
  } catch (error) {
    showError('The research dataset could not be loaded. Check that data/corpus.json is available and open the site through a web server.', error);
    return;
  }

  // Persistent review keys retain compatibility with the supplied viewer.
  const corpusFingerprint = corpus.provenance.coordinate_sha256;
  const reviewStorageKey = 'topic-review:' + corpusFingerprint + ':topic-review:hierarchy-leiden05:v1';
  const state = {
    solution: DEFAULT_SOLUTION, group: '', subgroup: '', page: 0, scope: 'global',
    mapMode: 'parents', labelMode: 'names', selectedPMID: null
  };
  const docs = corpus.docs.map((record, i) => ({ ...record, i, x: +record.UMAP1, y: +record.UMAP2 }));
  const byPMID = new Map(docs.map(record => [String(record.PMID), record]));
  const leafIDs = [...Object.keys(corpus.names.subtopic_names),
    ...Object.keys(corpus.names.parent_names).filter(id => !corpus.names.selected_k[id])];
  const PARENT_COLORS = ['#297eaa', '#d58a36', '#438e69', '#8a6aab', '#be6570'];
  const OTHER_COLORS = ['#297eaa', '#6ea4c1', '#cf8433', '#d8a65a', '#438e69', '#86aa70',
    '#bd5c66', '#d78d91', '#8a6aab', '#b09bc5', '#a37e5e', '#bd9a84', '#a86595',
    '#cd95b7', '#596979', '#89939c', '#93822b', '#c0ac59', '#398f98', '#7bb7bb'];
  const LEAF_COLORS = ['#287fac', '#ca7f2a', '#4a9465', '#b95060', '#8163a5', '#99754e',
    '#b46f9d', '#6c7a87', '#8b902e', '#2c9ca0', '#4a568a', '#678048', '#8b8cc3',
    '#a86c84', '#a77834', '#4d7f77'];

  // English display notes; original research annotations remain in the dataset.
  const interpretationNotes = {
    '1': 'Proposed K = 5. Within 2,400 articles, this separates sequencing methods, software, biomolecular prediction and networks, statistics and information extraction, and databases and annotation. Mean ARI: 0.938. K = 2 has a higher silhouette; K = 3–4 is slightly more stable, but produces broader methodological themes. Five subgroups provide interpretable detail, rather than a demonstrated numerical optimum. Exceptions and shared applications occur in every subgroup.',
    '2': 'Proposed K = 4. This separates molecular modelling, organismal omics, regulation and function, and evolutionary genomics. Mean ARI: 0.987. K = 2 has a higher silhouette but combines distinct topics. Subtopic 2.2 includes plants, microbes and other organisms; it does not represent all plant or environmental bioinformatics in the corpus. Examples such as ancient DNA illustrate imperfect boundaries.',
    '3': 'Proposed K = 3. This distinguishes clinical genetics, omics signatures and cellular disease mechanisms. Mean ARI: 0.992. K = 2 has a higher silhouette but does not separate clinical genetics as clearly. The second subtopic also includes physiology and development; the third is enriched for oncology but is not exclusively about cancer. These are dominant approaches, not mutually exclusive disease categories.',
    '4': 'Proposed K = 3. This distinguishes neural and cellular dynamics; biomedical prediction, modelling and imaging; and systems and metabolic models. Mean ARI: 0.981. K = 2 has a higher silhouette but mixes different applications; K = 4–6 is less stable. Random examples show overlap, especially between cellular dynamics and other simulations.',
    '5': 'Retained without thematic subdivision. This includes reviews, perspectives, infrastructure, training and translation. Although K = 2 is perfectly reproducible across seeds and has the highest local silhouette, the examples do not define two clear scientific branches. Grouping may reflect article style or type. Do not treat every record as a review without checking publication types. Expert review is still needed.'
  };

  const nameKey = (group, sub = '') => sub ? 'sub:' + sub : `parent:${state.solution}:${group}`;

  /**
   * Accept only review identifiers that belong to the supplied hierarchy or solution.
   */

  function validReviewKey(key) {
    if (key.startsWith('sub:')) return Object.hasOwn(corpus.names.subtopic_names, key.slice(4));
    if (!key.startsWith('parent:')) return false;
    const [, solution, group] = key.split(':');
    return !!corpus.solutions[solution] && corpus.solutions[solution].labels.some(label => String(label) === group);
  }

  /**
   * Normalize review entries and enforce the same text limits as the editor.
   * Invalid entries are ignored when loading optional local state.
   */

  function cleanReviews(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (!validReviewKey(key) || typeof value?.name !== 'string' || !value.name.trim()) continue;
      output[key] = { name: value.name.trim().slice(0, REVIEW_NAME_LIMIT), notes: String(value.notes ?? '').slice(0, REVIEW_NOTES_LIMIT) };
    }
    return output;
  }

  /**
   * Merge optional bootstrap reviews with browser edits; browser entries take precedence.
   */

  function loadReviews() {
    let initial = {};
    try {
      initial = cleanReviews(JSON.parse($('initial-review').textContent || '{}'));
    } catch {
      // Initial review JSON is optional; malformed data must not block the explorer.
    }

    try {
      const stored = cleanReviews(JSON.parse(localStorage.getItem(reviewStorageKey) || '{}'));
      return { ...initial, ...stored };
    } catch {
      // Storage restrictions must not discard valid bootstrap reviews.
      return initial;
    }
  }

  let reviews = loadReviews();

  const proposedName = (group, sub = '') => sub
    ? corpus.names.subtopic_names[sub] || `Subtopic ${sub}`
    : state.solution === DEFAULT_SOLUTION ? corpus.names.parent_names[group]
      : corpus.names.solution_names?.[state.solution]?.[group] || `Group ${group}`;
  const displayName = (group, sub = '') => reviews[nameKey(group, sub)]?.name || proposedName(group, sub);
  const currentKey = () => state.group ? nameKey(state.group, state.subgroup) : null;
  const groupIDs = () => [...new Set(corpus.solutions[state.solution].labels)].sort((a, b) => a - b).map(String);
  const isLeafView = () => state.solution === DEFAULT_SOLUTION && state.mapMode === 'subgroups';
  const categoryID = record => isLeafView()
    ? String(record.subtopic_id || record.parent_group)
    : recordGroup(record);

  function solutionName(key) {
    if (key.startsWith('leiden_')) return 'Leiden · resolution ' + key.split('_r')[1];
    if (key.startsWith('kmeans_')) return 'K-means · K = ' + key.split('_k')[1];
    const match = key.match(/^pca(\d+)_k(\d+)$/);
    return match ? `PCA ${match[1]} + K-means · K = ${match[2]}` : key;
  }

  /**
   * Build select options with textContent so labels are never interpreted as markup.
   */

  function setOptions(element, options, value) {
    element.replaceChildren(...options.map(([key, text]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = text;
      return option;
    }));
    element.value = value;
  }

  function refreshGroups() {
    setOptions($('group'), [['', 'All research groups'], ...groupIDs().map(id => [id, `${id} · ${displayName(id)}`])], state.group);
    refreshSubgroups();
  }

  function refreshSubgroups() {
    const enabled = state.solution === DEFAULT_SOLUTION && !!corpus.names.selected_k[state.group];
    if (!enabled) state.subgroup = '';
    const items = enabled ? Object.keys(corpus.names.subtopic_names)
      .filter(id => id.startsWith(state.group + '.')).map(id => [id, `${id} · ${displayName(state.group, id)}`]) : [];
    setOptions($('subgroup'), [['', enabled ? 'All subtopics' : 'Select a Leiden parent group'], ...items], state.subgroup);
    $('subgroup').disabled = !enabled;
  }

  let visibleDocs = [], visibleDocIndices = new Set(), searchTimer, toastTimer;

  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, TOAST_DURATION_MS);
  }

  function saveReviews(message = 'Changes saved in this browser.') {
    let saved = true;
    try { localStorage.setItem(reviewStorageKey, JSON.stringify(reviews)); } catch { saved = false; }
    $('saveStatus').textContent = saved ? message : 'Saved for this session only. Export a copy to keep your changes.';
    notify($('saveStatus').textContent);
  }

  function recordGroup(record) {
    return String(corpus.solutions[state.solution].labels[record.i]);
  }

  function recordSubtopic(record) {
    return state.solution === DEFAULT_SOLUTION ? record.subtopic_id : '';
  }

  /**
   * Filter and sort derived records, then clamp pagination to the available results.
   * The original corpus records and coordinate arrays remain unchanged.
   */

  function filterDocs() {
    const query = $('search').value.trim().toLowerCase();
    const year = $('year').value;
    visibleDocs = docs.filter(record => (!state.group || recordGroup(record) === state.group)
      && (!state.subgroup || record.subtopic_id === state.subgroup)
      && (!year || String(record.Year) === year)
      && (!query || `${record.Title} ${record.PMID}`.toLowerCase().includes(query)));
    const sort = $('sort').value;
    if (sort === 'newest') visibleDocs.sort((a, b) => +b.Year - +a.Year || a.i - b.i);
    if (sort === 'oldest') visibleDocs.sort((a, b) => +a.Year - +b.Year || a.i - b.i);
    if (sort === 'title') visibleDocs.sort((a, b) => a.Title.localeCompare(b.Title, 'en'));
    visibleDocIndices = new Set(visibleDocs.map(record => record.i));
    state.page = Math.min(state.page, Math.max(0, Math.ceil(visibleDocs.length / PAGE_SIZE) - 1));
  }

  /**
   * Keep the inspector, review fields and descriptors aligned with the active selection.
   */

  function syncEditor() {
    const key = currentKey();
    for (const id of ['nameEdit', 'notesEdit', 'applyName', 'restoreName']) $(id).disabled = !key;
    $('nameEdit').value = key ? (reviews[key]?.name || proposedName(state.group, state.subgroup)) : '';
    $('notesEdit').value = key ? (reviews[key]?.notes || '') : '';
    $('groupTitle').textContent = key ? `${state.subgroup || state.group} · ${displayName(state.group, state.subgroup)}` : 'A closer look at the research';
    $('selectionCount').textContent = `${formatNumber(visibleDocs.length)} of ${formatNumber(docs.length)} mapped articles`;
    $('inspectorHelp').hidden = !!key;
    $('termNote').hidden = !key;
    const terms = state.subgroup
      ? (corpus.subtopics.find(row => row.subtopic_id === state.subgroup)?.terms || '').split('; ')
      : corpus.solutions[state.solution].terms[state.group] || [];
    $('terms').innerHTML = key ? terms.filter(Boolean).slice(0, 14).map(term => `<span class="chip">${escapeHTML(term)}</span>`).join('') : '';
    const note = state.solution === DEFAULT_SOLUTION ? interpretationNotes[state.group] : '';
    $('interpretationDetails').hidden = !note;
    $('groupNote').textContent = note || '';
  }

  // Canvas rendering uses a cached offscreen layer while panning or zooming.
  const canvas = $('map'), mapContext = canvas.getContext('2d');
  if (!mapContext) {
    showError('Your browser cannot display the map canvas. Try a current browser.');
    return;
  }
  let canvasWidth = 600, canvasHeight = 475, zoom = 1, panX = 0, panY = 0;
  let positions = [], labelBoxes = [], drag = null, draggedDistance = 0, drawQueued = false;
  let layerKey = '', cachedLayer = null;
  const minX = Math.min(...docs.map(record => record.x)), maxX = Math.max(...docs.map(record => record.x));
  const minY = Math.min(...docs.map(record => record.y)), maxY = Math.max(...docs.map(record => record.y));
  const anchorCache = new Map();

  function categoryInfo(key) {
    const local = isLeafView() && key.includes('.');
    const group = local ? key.split('.')[0] : key;
    const colors = isLeafView() ? LEAF_COLORS : state.solution === DEFAULT_SOLUTION ? PARENT_COLORS : OTHER_COLORS;
    const index = isLeafView() ? leafIDs.indexOf(key) : Number(group) - 1;
    return { key, group, sub: local ? key : '', name: displayName(group, local ? key : ''), color: colors[(index + colors.length) % colors.length] };
  }

  /**
   * Project supplied UMAP coordinates into canvas CSS pixels.
   * This is a display transform only; it does not recompute embeddings or clusters.
   * @param {{x: number, y: number}} record Original coordinates or a label anchor.
   * @returns {[number, number]} Canvas position after zoom and pan.
   */

  function point(record) {
    const scale = Math.min((canvasWidth - 62) / (maxX - minX), (canvasHeight - 62) / (maxY - minY));
    return [(record.x - (minX + maxX) / 2) * scale * zoom + canvasWidth / 2 + panX,
      ((minY + maxY) / 2 - record.y) * scale * zoom + canvasHeight / 2 + panY];
  }

  /**
   * Size the backing canvas for the display pixel ratio and invalidate its cached layer.
   */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvasWidth = Math.max(1, rect.width); canvasHeight = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    mapContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    layerKey = '';
    requestDraw();
  }

  /**
   * Cache one label anchor per displayed category.
   * Use the article nearest the category mean, not an empty centroid position.
   */

  function anchors() {
    const key = state.solution + ':' + (isLeafView() ? 'leaves' : 'parents');
    if (anchorCache.has(key)) return anchorCache.get(key);
    const buckets = new Map();
    for (const record of docs) {
      const id = categoryID(record);
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(record);
    }
    const result = [];
    for (const [id, records] of buckets) {
      const x = records.reduce((sum, record) => sum + record.x, 0) / records.length;
      const y = records.reduce((sum, record) => sum + record.y, 0) / records.length;
      const closest = records.reduce((best, record) =>
        (record.x - x) ** 2 + (record.y - y) ** 2 < (best.x - x) ** 2 + (best.y - y) ** 2 ? record : best);
      result.push({ key: id, x: closest.x, y: closest.y, count: records.length });
    }
    result.sort((a, b) => b.count - a.count);
    anchorCache.set(key, result);
    return result;
  }

  function wrapLabel(text, width) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (line && mapContext.measureText(next).width > width) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function overlap(a, b) {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  }

  /**
   * Place labels near their anchors while penalizing overlap with already placed labels.
   */

  function drawLabels() {
    labelBoxes = [];
    if (state.labelMode === 'hidden') return;
    const active = new Set(visibleDocs.map(categoryID));
    const maxWidth = Math.max(95, Math.min(157, canvasWidth * 0.28));
    mapContext.save();
    mapContext.font = state.labelMode === 'ids' ? 'bold 11px system-ui' : '500 10px system-ui';
    mapContext.textBaseline = 'top';
    for (const anchor of anchors()) {
      if (!active.has(anchor.key)) continue;
      const [px, py] = point(anchor);
      if (px < 0 || py < 0 || px > canvasWidth || py > canvasHeight) continue;
      const meta = categoryInfo(anchor.key);
      const lines = state.labelMode === 'ids' ? [anchor.key] : wrapLabel(`${anchor.key} · ${meta.name}`, maxWidth);
      const w = Math.min(canvasWidth - 35, Math.max(...lines.map(line => mapContext.measureText(line).width)) + 14);
      const h = lines.length * 13 + 10;
      let best = null, score = Infinity;
      for (let radius = 0; radius <= 240; radius += 24) {
        const steps = radius ? 12 : 1;
        for (let j = 0; j < steps; j++) {
          const angle = j / steps * Math.PI * 2;
          const x = Math.max(22, Math.min(canvasWidth - w - 12, px - w / 2 + Math.cos(angle) * radius));
          const y = Math.max(36, Math.min(canvasHeight - h - 40, py - h / 2 + Math.sin(angle) * radius));
          const box = { x, y, w, h, key: anchor.key, px, py, meta, lines };
          const occupied = labelBoxes.reduce((sum, previous) => sum + overlap({ x: x - 4, y: y - 4, w: w + 8, h: h + 8 }, previous), 0);
          const candidate = occupied * 1000 + (x + w / 2 - px) ** 2 + (y + h / 2 - py) ** 2;
          if (candidate < score) { score = candidate; best = box; }
        }
      }
      if (best) labelBoxes.push(best);
    }
    for (const box of labelBoxes) {
      mapContext.strokeStyle = box.meta.color;
      mapContext.lineWidth = 0.8;
      mapContext.globalAlpha = 0.7;
      mapContext.beginPath();
      mapContext.moveTo(box.px, box.py);
      mapContext.lineTo(Math.max(box.x, Math.min(box.x + box.w, box.px)), Math.max(box.y, Math.min(box.y + box.h, box.py)));
      mapContext.stroke();
    }
    for (const box of labelBoxes) {
      mapContext.globalAlpha = 0.96;
      mapContext.fillStyle = '#ffffff';
      mapContext.fillRect(box.x, box.y, box.w, box.h);
      mapContext.globalAlpha = 1;
      mapContext.strokeStyle = box.meta.color;
      mapContext.lineWidth = 0.9;
      mapContext.strokeRect(box.x, box.y, box.w, box.h);
      mapContext.fillStyle = '#193a35';
      box.lines.forEach((line, i) => mapContext.fillText(line, box.x + 7, box.y + 5 + i * 13));
    }
    mapContext.restore();
  }

  /**
   * Reuse the article layer until geometry or filtering changes; draw selection and labels above it.
   */

  function draw() {
    mapContext.clearRect(0, 0, canvasWidth, canvasHeight);
    mapContext.fillStyle = '#fafcfb';
    mapContext.fillRect(0, 0, canvasWidth, canvasHeight);
    // Rebuild only when view geometry or filtering changes.
    const key = [canvasWidth, canvasHeight, zoom, panX, panY, state.solution, state.mapMode, state.group,
      state.subgroup, $('search').value, $('year').value].join('|');
    if (key !== layerKey) {
      cachedLayer = document.createElement('canvas');
      cachedLayer.width = canvas.width; cachedLayer.height = canvas.height;
      const layer = cachedLayer.getContext('2d');
      layer.setTransform(canvas.width / canvasWidth, 0, 0, canvas.height / canvasHeight, 0, 0);
      positions = [];
      for (const foreground of [false, true]) {
        for (const record of docs) {
          const show = visibleDocIndices.has(record.i);
          if (show !== foreground) continue;
          const [x, y] = point(record);
          if (x < 0 || x > canvasWidth || y < 0 || y > canvasHeight) continue;
          layer.fillStyle = show ? categoryInfo(categoryID(record)).color : '#d6e0da';
          layer.globalAlpha = show ? 0.8 : 0.3;
          layer.beginPath(); layer.arc(x, y, show ? (state.group ? 2.8 : 2.2) : 1.4, 0, Math.PI * 2); layer.fill();
          if (show) positions.push({ record, x, y });
        }
      }
      layerKey = key;
    }
    mapContext.drawImage(cachedLayer, 0, 0, canvasWidth, canvasHeight);
    if (state.selectedPMID) {
      const selected = positions.find(item => String(item.record.PMID) === state.selectedPMID);
      if (selected) { mapContext.strokeStyle = '#112e39'; mapContext.lineWidth = 1.8; mapContext.beginPath(); mapContext.arc(selected.x, selected.y, 6, 0, Math.PI * 2); mapContext.stroke(); }
    }
    mapContext.fillStyle = '#677c72';
    mapContext.font = '10px system-ui';
    mapContext.fillText('UMAP 1', canvasWidth - 63, canvasHeight - 12);
    mapContext.save();
    mapContext.translate(13, 73);
    mapContext.rotate(-Math.PI / 2);
    mapContext.fillText('UMAP 2', 0, 0);
    mapContext.restore();
    mapContext.fillText(`${formatNumber(visibleDocs.length)} highlighted articles`, 16, canvasHeight - 12);
    mapContext.fillStyle = '#33584a';
    mapContext.font = '600 10px system-ui';
    mapContext.fillText(isLeafView() ? 'BiomedBERT · proposed local subtopics' : 'BiomedBERT · broad research groups', 17, 21);
    drawLabels();
    $('zoomLevel').textContent = Math.round(zoom * 100) + '%';
  }

  /**
   * Coalesce repeated interaction events into one draw per animation frame.
   */

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function focusCategory(id) {
    const meta = categoryInfo(id);
    state.group = meta.group;
    state.subgroup = meta.sub;
    state.page = 0;
    refreshGroups();
    update();
    renderMetrics();
  }

  function renderLegend() {
    const keys = isLeafView() ? leafIDs : groupIDs();
    const counts = {};
    docs.forEach(record => { const key = categoryID(record); counts[key] = (counts[key] || 0) + 1; });
    $('legend').innerHTML = keys.map(key => {
      const meta = categoryInfo(key);
      const selected = state.group === meta.group && (!state.subgroup || state.subgroup === meta.sub);
      return `<button data-category="${escapeHTML(key)}" aria-pressed="${selected}"><span class="swatch" style="background:${meta.color}"></span><span>${escapeHTML(key)} · ${escapeHTML(meta.name)} <span class="count">${formatNumber(counts[key] || 0)}</span></span></button>`;
    }).join('');
  }

  /**
   * Hit-test visible article positions within a ten-pixel radius (squared distance < 100).
   */

  function nearest(x, y) {
    let best = null, distance = 100;
    for (const position of positions) {
      const squared = (position.x - x) ** 2 + (position.y - y) ** 2;
      if (squared < distance) { distance = squared; best = position; }
    }
    return best;
  }
  const labelAt = (x, y) => labelBoxes.find(box => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);

  function articleDetail(record) {
    state.selectedPMID = String(record.PMID);
    const group = recordGroup(record);
    $('articleInfo').hidden = false;
    $('articleInfo').innerHTML = `<div class="eyebrow">Selected publication</div><strong>${escapeHTML(record.Title)}</strong><p>${escapeHTML(record.Year)} · <a href="${pubmedURL(record.PMID)}" target="_blank" rel="noopener noreferrer">PMID ${escapeHTML(record.PMID)} ↗</a> · ${escapeHTML(displayName(group))}${state.solution === DEFAULT_SOLUTION && record.subtopic_id ? ' / ' + escapeHTML(displayName(group, record.subtopic_id)) : ''}</p>`;
    requestDraw();
  }

  /**
   * Zoom around a fixed canvas position so the point under the pointer stays in place.
   */

  function zoomAt(factor, x = canvasWidth / 2, y = canvasHeight / 2) {
    const next = Math.max(0.5, Math.min(20, zoom * factor));
    panX = x - canvasWidth / 2 - (x - canvasWidth / 2 - panX) * next / zoom;
    panY = y - canvasHeight / 2 - (y - canvasHeight / 2 - panY) * next / zoom;
    zoom = next;
    requestDraw();
  }

  function resetView() { zoom = 1; panX = panY = 0; requestDraw(); }

  /**
   * Register pointer, wheel and keyboard interaction once.
   * Pointer capture preserves dragging when the pointer leaves the canvas.
   */

  function bindMapEvents() {
    canvas.addEventListener('pointerdown', event => {
      if (!event.isPrimary) return;
      drag = { x: event.clientX, y: event.clientY }; draggedDistance = 0;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      const bounds = canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      if (drag) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        draggedDistance += Math.abs(dx) + Math.abs(dy); panX += dx; panY += dy;
        drag = { x: event.clientX, y: event.clientY };
        $('tooltip').style.display = 'none'; requestDraw(); return;
      }
      const hit = labelAt(x, y) ? null : nearest(x, y);
      if (!hit) { $('tooltip').style.display = 'none'; return; }
      const record = hit.record, group = recordGroup(record);
      $('tooltip').innerHTML = `<strong>${escapeHTML(record.Title)}</strong><br>PMID ${escapeHTML(record.PMID)} · ${escapeHTML(record.Year)}<br>${escapeHTML(displayName(group))}`;
      $('tooltip').style.display = 'block';
      $('tooltip').style.left = Math.max(3, Math.min(x + 12, canvasWidth - $('tooltip').offsetWidth - 6)) + 'px';
      $('tooltip').style.top = Math.max(3, Math.min(y + 12, canvasHeight - $('tooltip').offsetHeight - 6)) + 'px';
    });
    canvas.addEventListener('pointerup', event => {
      if (!drag) return;
      drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (draggedDistance > 4) return;
      const bounds = canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      const label = labelAt(x, y), hit = nearest(x, y);
      if (label) focusCategory(label.key);
      else if (hit) articleDetail(hit.record);
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('lostpointercapture', () => { drag = null; });
    canvas.addEventListener('pointerleave', () => { $('tooltip').style.display = 'none'; });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.001), event.clientX - bounds.left, event.clientY - bounds.top);
    }, { passive: false });
    canvas.addEventListener('keydown', event => {
      if (!['+', '=', '-', '0', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === '+' || event.key === '=') zoomAt(1.2);
      if (event.key === '-') zoomAt(1 / 1.2);
      if (event.key === '0') resetView();
      if (event.key === 'ArrowLeft') panX -= 25;
      if (event.key === 'ArrowRight') panX += 25;
      if (event.key === 'ArrowUp') panY -= 25;
      if (event.key === 'ArrowDown') panY += 25;
      requestDraw();
    });
  }

  // Paginated table provides a keyboard-accessible alternative to the canvas.

  /**
   * Render one page of matching articles and the independently supplied interpretation examples.
   */

  function renderArticles() {
    const start = state.page * PAGE_SIZE;
    const records = visibleDocs.slice(start, start + PAGE_SIZE);
    const rows = records.map(record => {
      const group = recordGroup(record);
      const sub = recordSubtopic(record);
      return `<tr${String(record.PMID) === state.selectedPMID ? ' class="selected"' : ''}><td><a href="${pubmedURL(record.PMID)}" target="_blank" rel="noopener noreferrer">${escapeHTML(record.PMID)} ↗</a></td><td>${escapeHTML(record.Year)}</td><td class="topic-cell"><span>${escapeHTML(sub || group)}</span>${escapeHTML(displayName(group, sub))}</td><td class="title-cell"><button class="article-title-button" data-pmid="${escapeHTML(record.PMID)}">${escapeHTML(record.Title)}</button></td></tr>`;
    }).join('');
    $('articleTable').innerHTML = `<table><caption class="sr-only">Publication records matching the current filters</caption><thead><tr><th scope="col">PMID</th><th scope="col">Year</th><th scope="col">Research topic</th><th scope="col">Publication title</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-results">No articles match these filters. Try a different title, PMID or year.</td></tr>'}</tbody></table>`;
    $('articlePage').textContent = visibleDocs.length ? `${formatNumber(start + 1)}–${formatNumber(Math.min(start + PAGE_SIZE, visibleDocs.length))} of ${formatNumber(visibleDocs.length)}` : 'No results';
    $('prevArticles').disabled = state.page === 0;
    $('nextArticles').disabled = start + PAGE_SIZE >= visibleDocs.length;
    $('resultSummary').textContent = `${formatNumber(visibleDocs.length)} publications${visibleDocs.length !== docs.length ? ' match your selection' : ' available to explore'}`;
    $('activeFilterNote').textContent = state.group ? displayName(state.group, state.subgroup) : 'All research groups';
    let examples = [];
    if (state.group) {
      examples = state.subgroup ? corpus.subexamples.filter(record => record.subtopic_id === state.subgroup)
        : corpus.solutions[state.solution].examples.filter(record => String(record.tema_id) === state.group);
    }
    $('examples').innerHTML = state.group ? `<h3>Example articles for interpretation</h3><p>Supplied examples of the selected topic. These examples are independent of the title and year filters.</p>${examples.map(record => `<details><summary>${escapeHTML(record.Title)}</summary><p class="muted">${record.tipo === 'central' ? 'Central example' : record.tipo === 'aleatorio' ? 'Random example' : 'Supplied example'} · <a href="${pubmedURL(record.PMID)}" target="_blank" rel="noopener noreferrer">PMID ${escapeHTML(record.PMID)} ↗</a></p><p>${escapeHTML(record.Abstract)}</p></details>`).join('') || '<p>No examples were supplied for this topic.</p>'}` : '';
  }

  function update() {
    const hierarchy = state.solution === DEFAULT_SOLUTION;
    if (!hierarchy) state.mapMode = 'parents';
    $('mapMode').value = state.mapMode;
    $('mapMode').querySelector('option[value="subgroups"]').disabled = !hierarchy;
    $('allSubgroups').disabled = !hierarchy;
    filterDocs();
    syncEditor();
    renderLegend();
    renderArticles();
    requestDraw();
    if (state.selectedPMID) {
      const selected = byPMID.get(state.selectedPMID);
      if (!selected || !visibleDocIndices.has(selected.i)) { state.selectedPMID = null; $('articleInfo').hidden = true; }
      else articleDetail(selected);
    }
  }

  // Quantitative comparison: summaries and individual seeds use original values.

  /**
   * Map supplied global or local summary fields into a shared display shape without recalculation.
   */

  function summaries() {
    if (state.scope === 'global') return Object.entries(corpus.solutions).map(([key, item]) => ({
      key, mean: +item.summary.silhouette_original_media, sd: +item.summary.silhouette_original_sd,
      ari: +item.summary.ari_medio, minARI: +item.summary.ari_minimo,
      groups: +item.summary.grupos_mediana, range: `${item.summary.grupos_min}–${item.summary.grupos_max}`,
      seed: +item.summary.semilla_representativa
    }));
    return corpus.localSummary.map(item => ({ key: `Group ${item.tema_padre} · K=${item.k}`,
      parent: +item.tema_padre, k: +item.k, mean: +item.silhouette_media, sd: +item.silhouette_sd,
      ari: +item.ari_medio, minARI: +item.ari_minimo, groups: +item.k, range: item.k,
      seed: +item.semilla_representativa }));
  }

  /**
   * Normalize global and local seed field names while preserving their supplied values.
   */

  function seeds() {
    if (state.scope === 'global') return corpus.seedMetrics.map(item => ({ key: item.solucion,
      seed: +item.seed, groups: +item.grupos, silhouette: +item.silhouette_original,
      inertia: item.inertia_espacio_ajuste === '' ? '' : +item.inertia_espacio_ajuste,
      min_size: +item.grupo_minimo, max_size: +item.grupo_maximo,
      small_groups: +item.grupos_menos_10, groups_in_sample: +item.grupos_presentes_muestra,
      groups_absent_from_sample: +item.grupos_ausentes_muestra }));
    return corpus.localSeeds.map(item => ({ key: `Group ${item.parent_group} · K=${item.k}`,
      seed: +item.seed, groups: +(item.grupos_activos ?? item.grupos),
      silhouette: +(item.silhouette_coseno_original ?? item.silhouette_original ?? item.silhouette),
      inertia: item.inertia_pca ?? item.inertia ?? '', min_size: +(item.grupo_minimo ?? item.tamano_minimo),
      max_size: +(item.grupo_maximo ?? item.tamano_maximo), small_groups: item.grupos_menos_10 ?? '' }));
  }
  const isChosen = row => state.scope === 'global' ? row.key === state.solution
    : state.solution === DEFAULT_SOLUTION && +state.group === row.parent && corpus.names.selected_k[state.group] === row.k;

  /**
   * Retain integer values and the existing six-decimal precision used by metric tables.
   */

  function formatMetricValue(value) {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? value : value.toFixed(6);
    }
    return value ?? '';
  }

  function table(element, records, columns, selected = () => false) {
    const heading = columns.map(([, text]) => `<th scope="col">${escapeHTML(text)}</th>`).join('');
    const body = records.map(record => {
      const cells = columns.map(([key]) => `<td>${escapeHTML(formatMetricValue(record[key]))}</td>`).join('');
      return `<tr${selected(record) ? ' class="selected"' : ''}>${cells}</tr>`;
    }).join('');
    element.innerHTML = `<table><thead><tr>${heading}</tr></thead><tbody>${body}</tbody></table>`;
  }

  /**
   * Render original seed values and supplied mean ± standard deviation as an accessible SVG.
   */

  function plotMetrics(rows, runs) {
    const width = 1050, left = 180, right = 105, top = 32, rowHeight = 28;
    const height = top + rows.length * rowHeight + 38;
    const values = [...runs.map(row => row.silhouette), ...rows.flatMap(row => [row.mean - row.sd, row.mean + row.sd])].filter(Number.isFinite);
    const low = Math.min(0, ...values) - 0.003, high = Math.max(...values) + 0.004;
    const x = value => left + (value - low) / (high - low) * (width - left - right);
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="metricChartTitle metricChartDesc"><title id="metricChartTitle">Silhouette values by clustering solution</title><desc id="metricChartDesc">Individual seeds, mean and one standard deviation. Exact values are available in the summary table below.</desc>`;
    for (let i = 0; i <= 5; i++) {
      const value = low + (high - low) * i / 5;
      svg += `<line x1="${x(value)}" y1="14" x2="${x(value)}" y2="${height - 28}" stroke="#e3eae5"/><text x="${x(value)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#67796e">${value.toFixed(3)}</text>`;
    }
    rows.forEach((row, i) => {
      const y = top + i * rowHeight, color = isChosen(row) ? '#146b62' : '#75887c';
      if (isChosen(row)) svg += `<rect x="0" y="${y - 13}" width="${width}" height="27" rx="4" fill="#edf5ef"/>`;
      svg += `<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-size="11" fill="#304f40">${escapeHTML(row.key)}</text><line x1="${x(row.mean - row.sd)}" x2="${x(row.mean + row.sd)}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="3"/>`;
      runs.filter(run => run.key === row.key && Number.isFinite(run.silhouette)).forEach((run, j) => {
        svg += `<circle cx="${x(run.silhouette)}" cy="${y + (j - 2) * 2}" r="3" fill="#b2c0b5"><title>Seed ${run.seed}: ${run.silhouette}</title></circle>`;
      });
      svg += `<circle cx="${x(row.mean)}" cy="${y}" r="4" fill="${color}"/><text x="${width - right + 14}" y="${y + 4}" font-size="11" fill="#304f40">${row.mean.toFixed(5)}</text>`;
    });
    $('metricPlot').innerHTML = svg + '</svg>';
  }

  function renderSeedTable() {
    const filter = $('seedFilter').value;
    table($('seedTable'), seeds().filter(row => !filter || row.key === filter), [
      ['key', 'Solution'], ['seed', 'Seed'], ['groups', 'Groups'], ['silhouette', 'Original-space silhouette'],
      ['inertia', 'Fit-space inertia'], ['min_size', 'Smallest group'], ['max_size', 'Largest group'],
      ['small_groups', 'Groups <10'], ...(state.scope === 'global'
        ? [['groups_in_sample', 'Groups in sample'], ['groups_absent_from_sample', 'Groups absent from sample']] : [])
    ]);
  }

  function renderMetrics() {
    const rows = summaries(), runs = seeds(), current = rows.find(isChosen);
    for (const scope of ['global', 'local']) {
      const tab = $(scope + 'Tab'), active = scope === state.scope;
      tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    $('evaluationPanel').setAttribute('aria-labelledby', state.scope + 'Tab');
    $('localMetricNote').hidden = state.scope !== 'local';
    $('metricBrief').innerHTML = `<div><span class="caption">${state.scope === 'global' ? 'CURRENT SOLUTION' : 'SELECTED LOCAL PROPOSAL'}</span><strong class="solution-value">${current ? escapeHTML(state.scope === 'global' ? solutionName(current.key) : current.key) : 'Select a Leiden parent'}</strong></div><div><span class="caption">MEAN SILHOUETTE</span><strong>${current ? current.mean.toFixed(5) : '—'}</strong></div><div><span class="caption">MEAN ARI</span><strong>${current ? current.ari.toFixed(3) : '—'}</strong></div><div><span class="caption">EVALUATED RUNS</span><strong>${formatNumber(runs.length)}</strong></div>`;
    plotMetrics(rows, runs);
    table($('summaryTable'), rows, [['key', 'Solution'], ['groups', 'Median groups / K'], ['range', 'Group range'],
      ['mean', 'Mean silhouette'], ['sd', 'Silhouette SD'], ['ari', 'Mean ARI'], ['minARI', 'Minimum ARI'], ['seed', 'Representative seed']], isChosen);
    setOptions($('seedFilter'), [['', 'All runs'], ...rows.map(row => [row.key, row.key])], current?.key || '');
    renderSeedTable();
  }

  // Download helpers: all exports are generated from the current local dataset.

  /**
   * Download a browser-generated file and release its object URL after the click is processed.
   */

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }

  function download(filename, content, type = 'application/json;charset=utf-8') {
    downloadBlob(filename, new Blob([content], { type }));
  }

  /**
   * Serialize the established CSV column order with a UTF-8 BOM and CRLF rows.
   * Escape quotes and guard text cells against spreadsheet formula interpretation.
   */

  function csvText(records) {
    const keys = ['PMID', 'Year', 'Title', 'solution', 'group', 'group_name', 'subtopic_id', 'subtopic_name', 'UMAP1', 'UMAP2'];
    const cell = value => {
      let text = String(value ?? '');
      // Prevent spreadsheet formula interpretation in downloaded metadata.
      if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return '\ufeff' + [keys.map(cell).join(','), ...records.map(record => keys.map(key => cell(record[key])).join(','))].join('\r\n');
  }

  /**
   * Apply pending search text before exporting the active selection and reviewed topic names.
   */

  function exportArticles() {
    // Apply any pending search input before producing an export.
    clearTimeout(searchTimer);
    filterDocs();
    const rows = visibleDocs.map(record => {
      const group = recordGroup(record);
      const sub = recordSubtopic(record);
      return { PMID: record.PMID, Year: record.Year, Title: record.Title, solution: state.solution,
        group, group_name: displayName(group), subtopic_id: sub, subtopic_name: sub ? displayName(group, sub) : '',
        UMAP1: Number(record.UMAP1), UMAP2: Number(record.UMAP2) };
    });
    download('bioinformatics_spain_articles.csv', csvText(rows), 'text/csv;charset=utf-8');
    update(); notify(`${formatNumber(rows.length)} article records exported.`);
  }

  /**
   * Draw the current filtered view before encoding the map as PNG.
   */

  function exportMap() {
    clearTimeout(searchTimer);
    filterDocs();
    layerKey = '';
    draw();
    canvas.toBlob(blob => {
      if (!blob) { notify('The map could not be exported. Please try again.'); return; }
      downloadBlob(`bioinformatics_spain_${isLeafView() ? 'subtopics' : state.solution}.png`, blob);
      notify('Map exported with the current labels and filters.');
    }, 'image/png');
  }

  function exportMetrics() {
    download('bioinformatics_spain_metrics.json', JSON.stringify({
      global_summaries: Object.fromEntries(Object.entries(corpus.solutions).map(([key, value]) => [key, value.summary])),
      global_runs: corpus.seedMetrics,
      local_summaries: corpus.localSummary,
      local_runs: corpus.localSeeds
    }, null, 2));
  }

  function exportProvenance() {
    download('bioinformatics_spain_provenance.json', JSON.stringify(corpus.provenance, null, 2));
  }

  function exportReviews() {
    download('bioinformatics_spain_reviews.json', JSON.stringify({ format: REVIEW_FORMAT, version: REVIEW_VERSION,
      coordinate_sha256: corpusFingerprint, exported_at: new Date().toISOString(), reviews }, null, 2));
    notify('Review file exported.');
  }

  /**
   * Validate format, version, corpus fingerprint and entries before merging imported edits.
   */

  async function importReviews(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > MAX_REVIEW_FILE_BYTES) throw new Error('The review file must be smaller than 2 MB.');
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== REVIEW_FORMAT || parsed.version !== REVIEW_VERSION || parsed.coordinate_sha256 !== corpusFingerprint) {
        throw new Error('This review file does not match the current corpus.');
      }
      const imported = cleanReviews(parsed.reviews);
      if (Object.keys(imported).length !== Object.keys(parsed.reviews || {}).length) throw new Error('The review file contains invalid entries.');
      reviews = { ...reviews, ...imported };
      saveReviews(`${Object.keys(imported).length} reviews imported. Matching entries were updated.`);
      refreshGroups();
      update();
    } catch (error) { notify(error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message); }
    finally { event.target.value = ''; }
  }

  function applyReview() {
    const key = currentKey(), name = $('nameEdit').value.trim();
    if (!key) return;
    if (!name) { $('saveStatus').textContent = 'Enter a name before saving.'; $('nameEdit').focus(); return; }
    reviews[key] = { name: name.slice(0, REVIEW_NAME_LIMIT), notes: $('notesEdit').value.trim().slice(0, REVIEW_NOTES_LIMIT) };
    saveReviews();
    refreshGroups();
    update();
  }

  function restoreReview() {
    const key = currentKey();
    if (key) { delete reviews[key]; saveReviews('Original proposal restored.'); refreshGroups(); update(); }
  }


  /**
   * Wire selection controls, pagination and accessible evaluation tabs once.
   */

  function bindInterfaceEvents() {
    $('solution').addEventListener('change', () => {
      state.solution = $('solution').value;
      state.group = state.subgroup = '';
      state.page = 0;
      refreshGroups();
      update();
      renderMetrics();
    });
    $('group').addEventListener('change', () => {
      state.group = $('group').value;
      state.subgroup = '';
      state.page = 0;
      refreshSubgroups();
      update();
      renderMetrics();
    });
    $('subgroup').addEventListener('change', () => {
      state.subgroup = $('subgroup').value;
      state.page = 0;
      if (state.subgroup) state.mapMode = 'subgroups';
      update();
    });
    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      state.page = 0;
      searchTimer = setTimeout(update, SEARCH_DEBOUNCE_MS);
    });
    for (const id of ['year', 'sort']) $(id).addEventListener('change', () => { state.page = 0; update(); });
    $('clearFilters').addEventListener('click', () => {
      clearTimeout(searchTimer);
      $('search').value = $('year').value = '';
      state.group = state.subgroup = '';
      state.page = 0;
      refreshGroups();
      update();
      renderMetrics();
    });
    $('mapMode').addEventListener('change', () => { state.mapMode = $('mapMode').value; update(); });
    $('labelMode').addEventListener('change', () => { state.labelMode = $('labelMode').value; requestDraw(); });
    $('allSubgroups').addEventListener('click', () => {
      state.mapMode = 'subgroups';
      state.group = state.subgroup = '';
      state.page = 0;
      refreshGroups();
      update();
      renderMetrics();
    });
    $('legend').addEventListener('click', event => {
      const button = event.target.closest('button[data-category]');
      if (button) focusCategory(button.dataset.category);
    });
    $('articleTable').addEventListener('click', event => {
      const button = event.target.closest('button[data-pmid]');
      if (!button) return;
      const record = byPMID.get(button.dataset.pmid);
      if (record) { articleDetail(record); notify(`Selected PMID ${record.PMID}; details appear below the map.`); }
    });
    $('zoomIn').addEventListener('click', () => zoomAt(1.25));
    $('zoomOut').addEventListener('click', () => zoomAt(0.8));
    $('resetView').addEventListener('click', resetView);
    $('expandMap').addEventListener('click', () => {
      const expanded = $('mapGrid').classList.toggle('expanded');
      $('expandMap').textContent = expanded ? 'Restore layout' : 'Expand map';
      $('expandMap').setAttribute('aria-expanded', String(expanded)); resize();
    });
    $('prevArticles').addEventListener('click', () => { if (state.page > 0) state.page--; renderArticles(); $('articleTable').scrollTop = 0; });
    $('nextArticles').addEventListener('click', () => { if ((state.page + 1) * PAGE_SIZE < visibleDocs.length) state.page++; renderArticles(); $('articleTable').scrollTop = 0; });
    function selectScope(scope) { state.scope = scope; renderMetrics(); }
    for (const scope of ['global', 'local']) {
      $(scope + 'Tab').addEventListener('click', () => selectScope(scope));
      $(scope + 'Tab').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'global' : event.key === 'End' ? 'local' : scope === 'global' ? 'local' : 'global';
        selectScope(next); $(next + 'Tab').focus();
      });
    }
    $('seedFilter').addEventListener('change', renderSeedTable);
  }


  /**
   * Populate selectors, corpus totals and provenance, then render the initial view.
   */

  function initializeInterface() {
    setOptions($('solution'), Object.keys(corpus.solutions).map(key => [key,
      solutionName(key) + (key === DEFAULT_SOLUTION ? ' · proposed hierarchy' : '')]), state.solution);
    setOptions($('year'), [['', 'All years'], ...[...new Set(docs.map(record => record.Year))].sort().reverse().map(year => [year, year])], '');
    $('corpusCount').textContent = formatNumber(corpus.provenance.corpus_articles);
    $('plottedCount').textContent = formatNumber(docs.length);
    $('coverageNote').textContent = `${(docs.length / corpus.provenance.corpus_articles * 100).toFixed(1)}% of the full corpus`;
    $('broadCount').textContent = formatNumber(Object.keys(corpus.names.parent_names).length);
    $('solutionCount').textContent = formatNumber(Object.keys(corpus.solutions).length);
    $('runsNote').textContent = `${formatNumber(corpus.seedMetrics.length)} global runs · five seeds each`;
    $('provenance').textContent = JSON.stringify(corpus.provenance, null, 2);
    refreshGroups();
    update();
    renderMetrics();
    resize();
  }

  /**
   * Keep canvas geometry synchronized with layout changes, with a window-resize fallback.
   */

  function observeMapSize() {
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas.parentElement);
    else window.addEventListener('resize', resize);
  }

  /**
   * Update aria-current from visible sections without changing document scroll position.
   */

  function observeNavigation() {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          document.querySelectorAll('.nav-links a').forEach(link => {
            if (link.hash === '#' + entry.target.id) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
          });
        }
      }, { rootMargin: '-15% 0px -65% 0px' });
      document.querySelectorAll('main .section[id]').forEach(section => observer.observe(section));
    }
  }

  function bindExportEvents() {
    $('downloadArticles').addEventListener('click', exportArticles);
    $('downloadMap').addEventListener('click', exportMap);
    $('downloadMetrics').addEventListener('click', exportMetrics);
    $('downloadProvenance').addEventListener('click', exportProvenance);
  }

  function bindReviewEvents() {
    $('exportReviews').addEventListener('click', exportReviews);
    $('importReviews').addEventListener('click', () => $('reviewFile').click());
    $('reviewFile').addEventListener('change', importReviews);
    $('applyName').addEventListener('click', applyReview);
    $('restoreName').addEventListener('click', restoreReview);
  }

  // Register handlers once, then render and observe the initialized document.
  bindMapEvents();
  bindExportEvents();
  bindReviewEvents();
  bindInterfaceEvents();
  initializeInterface();
  observeMapSize();
  observeNavigation();
})();
