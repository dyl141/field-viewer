// Field Viewer – Trimble Connect 3D Viewer extension
// FIRST DRAFT – UNTESTED. Checked against trimble-connect-workspace-api v0.3.40 type definitions.

const VERSION = '2.1';
const DEFAULT_FIELDS =
  'Mark=Tekla Common.ASSEMBLY1_POS, Product Name, Profile=Product Description, Grade=IFC Material.Material, Finish, Weight';
const CHUNK = 1000;       // object IDs per getObjectProperties call
const MAX_LABELS = 200;   // safety limit for text markups

let API;
let rows = [];            // [{ modelId, id, values: [..] }] for the current selection
let labelIds = [];        // markup ids we created, so we only remove our own

const $ = id => document.getElementById(id);
const fieldsEl = $('fields'), filterEl = $('filter'), out = $('out');
const setStatus = t => { $('status').textContent = t; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Normalise names so "Tekla Common.ASSEMBLY1_POS" matches "tekla_common.assembly1_pos" etc.
const norm = s => String(s).toLowerCase().replace(/[\s_]/g, '');

// --- Field list -------------------------------------------------------------
// Each entry: "Prop", "Set.Prop" or "Header=Set.Prop"
function wanted() {
  return fieldsEl.value.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return i > 0 ? { header: s.slice(0, i).trim(), key: s.slice(i + 1).trim() }
                 : { header: s, key: s };
  });
}

function saveFields() { try { localStorage.setItem('fv.fields', fieldsEl.value); } catch (e) {} }
function loadFields() {
  let v = null;
  try { v = localStorage.getItem('fv.fields'); } catch (e) {}
  fieldsEl.value = v || DEFAULT_FIELDS;
}

function fillDropdowns() {
  for (const sel of [$('colourField'), $('labelField')]) {
    const prev = sel.value;
    sel.innerHTML = wanted().map((f, i) => `<option value="${i}">${esc(f.header)}</option>`).join('');
    if (prev && prev < sel.options.length) sel.value = prev;
  }
}

// --- Property lookup --------------------------------------------------------
// ObjectProperties = { id, product?: {name, description, objectType}, properties?: PropertySet[] }
// Builds a lookup keyed by normalised "set.prop" and bare "prop" (first match wins).
function flatten(obj) {
  const m = {};
  const add = (set, name, value) => {
    const full = norm(`${set}.${name}`), bare = norm(name);
    if (!(full in m)) m[full] = value;
    if (!(bare in m)) m[bare] = value;
  };
  (obj.properties || []).forEach(set =>
    (set.properties || []).forEach(p => add(set.name || '', p.name, p.value)));
  // Product info sits outside the property sets – expose it as "Product.Name" and "Product Name"
  // (matches Trimble's own panel labels: "Product Name", "Product Description", "Product Object Type")
  if (obj.product) {
    const P = obj.product;
    if (P.name != null)        { add('Product', 'Name', P.name);               m[norm('Product Name')] ??= P.name; }
    if (P.description != null) { add('Product', 'Description', P.description); m[norm('Product Description')] ??= P.description; }
    if (P.objectType != null)  { add('Product', 'ObjectType', P.objectType);    m[norm('Product Object Type')] ??= P.objectType; }
  }
  return m;
}
const valueOf = (m, key) => m[norm(key)];

// getObjectProperties(modelId, objectRuntimeIds[]) -> ObjectProperties[], fetched in chunks
async function getProps(modelId, ids) {
  const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    all.push(...await API.viewer.getObjectProperties(modelId, ids.slice(i, i + CHUNK)));
  }
  return all;
}

// --- Selection table --------------------------------------------------------
let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const f = wanted();
  const sel = await API.viewer.getSelection();   // Selection = ModelObjectIds[]
  const newRows = [];
  let first = null;
  for (const s of sel) {
    if (!s.objectRuntimeIds || !s.objectRuntimeIds.length) continue;
    const props = await getProps(s.modelId, s.objectRuntimeIds);
    props.forEach(o => {
      if (!first) first = o;
      const m = flatten(o);
      newRows.push({ modelId: s.modelId, id: o.id, values: f.map(x => valueOf(m, x.key)) });
    });
  }
  if (token !== renderToken) return;   // a newer selection arrived meanwhile
  rows = newRows;
  drawTable();
  showAllProps(first);
}

function visibleRows() {
  const q = filterEl.value.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => r.values.some(v => String(v ?? '').toLowerCase().includes(q)));
}

function drawTable() {
  const f = wanted(), vis = visibleRows();
  if (!rows.length) { out.innerHTML = '<i>Select objects in the 3D view.</i>'; setStatus('0 objects selected'); return; }
  out.innerHTML = `<table><tr>${f.map(x => `<th>${esc(x.header)}</th>`).join('')}</tr>` +
    vis.map(r => `<tr>${r.values.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') +
    '</table>';
  setStatus(`${rows.length} object(s) selected` + (vis.length !== rows.length ? `, ${vis.length} shown` : ''));
}

// Lists every property set and property of the first selected object
function showAllProps(o) {
  const box = $('allProps');
  if (!o) { box.textContent = 'Select an object.'; return; }
  let t = '';
  if (o.product) t += `[Product]\n  Name = ${o.product.name ?? ''}\n  Description = ${o.product.description ?? ''}\n  ObjectType = ${o.product.objectType ?? ''}\n`;
  (o.properties || []).forEach(set => {
    t += `[${set.name}]\n`;
    (set.properties || []).forEach(p => { t += `  ${p.name} = ${p.value}\n`; });
  });
  box.textContent = t || 'No properties returned for this object.';
}

// --- Colour by field --------------------------------------------------------
function colourFor(v) {       // stable hash -> ColorRGBA (0-255)
  let h = 0;
  for (const c of String(v)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255, a: 255 };
}

async function colourBy() {
  const field = wanted()[$('colourField').value];
  if (!field) return setStatus('Add at least one field.');
  setStatus(`Colouring by "${field.header}"…`);
  const models = await API.viewer.getObjects();   // ModelObjects[] = { modelId, objects }
  const values = new Set();
  for (const mo of models) {
    const props = await getProps(mo.modelId, mo.objects.map(o => o.id));
    const groups = {};
    props.forEach(o => {
      const v = valueOf(flatten(o), field.key) ?? 'n/a';
      (groups[v] = groups[v] || []).push(o.id);
    });
    for (const [v, rids] of Object.entries(groups)) {
      values.add(v);
      await API.viewer.setObjectState(
        { modelObjectIds: [{ modelId: mo.modelId, objectRuntimeIds: rids }] },
        { color: colourFor(v) });
    }
  }
  setStatus(`Coloured by "${field.header}" – ${values.size} distinct value(s).`);
}

// --- Floating 3D labels (text markups) --------------------------------------
// getObjectBoundingBoxes -> metres; markup picks -> millimetres, so multiply by 1000.
async function labelSelected() {
  const idx = Number($('labelField').value);
  const field = wanted()[idx];
  if (!field) return setStatus('Add at least one field.');
  if (!rows.length) return setStatus('Select objects first.');
  const todo = rows.slice(0, MAX_LABELS);
  const byModel = {};
  todo.forEach(r => (byModel[r.modelId] = byModel[r.modelId] || []).push(r));
  const markups = [];
  for (const [modelId, list] of Object.entries(byModel)) {
    const boxes = await API.viewer.getObjectBoundingBoxes(modelId, list.map(r => r.id));
    const boxById = Object.fromEntries(boxes.map(b => [b.id, b.boundingBox]));
    list.forEach(r => {
      const b = boxById[r.id];
      const text = r.values[idx];
      if (!b || text == null || text === '') return;
      const x = (b.min.x + b.max.x) / 2 * 1000, y = (b.min.y + b.max.y) / 2 * 1000, z = b.max.z * 1000;
      markups.push({
        text: String(text),
        start: { positionX: x, positionY: y, positionZ: z, modelId, objectId: r.id },
        end:   { positionX: x, positionY: y, positionZ: z + 500 },   // label 500 mm above the top
        color: { r: 0, g: 99, b: 163, a: 255 }
      });
    });
  }
  if (!markups.length) return setStatus(`No "${field.header}" values to label.`);
  const added = await API.markup.addTextMarkup(markups);
  labelIds.push(...added.map(m => m.id).filter(id => id != null));
  setStatus(`Added ${added.length} label(s)` + (rows.length > MAX_LABELS ? ` (limited to ${MAX_LABELS})` : '') + '.');
}

async function clearLabels() {
  if (labelIds.length) await API.markup.removeMarkups(labelIds);
  labelIds = [];
  setStatus('Labels cleared.');
}

// --- CSV export / copy ------------------------------------------------------
function tableData() {
  return [wanted().map(f => f.header), ...visibleRows().map(r => r.values.map(v => v ?? ''))];
}

function exportCsv() {
  if (!rows.length) return setStatus('Select objects first.');
  const csv = tableData().map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'field-viewer.csv' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus('CSV exported. If nothing downloaded, use "Copy table" instead.');
}

async function copyTable() {
  if (!rows.length) return setStatus('Select objects first.');
  const tsv = tableData().map(r => r.map(v => String(v).replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(tsv);
  } catch (e) {          // clipboard API can be blocked inside iframes – fall back
    const ta = Object.assign(document.createElement('textarea'), { value: tsv });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  setStatus('Table copied – paste into Excel.');
}

// --- Start-up ---------------------------------------------------------------
(async () => {
  $('ver').textContent = 'Field Viewer v' + VERSION;
  loadFields();
  fillDropdowns();
  const safe = fn => () => fn().catch(e => setStatus('Error: ' + (e.message || e)));

  fieldsEl.onchange = () => { saveFields(); fillDropdowns(); if (API) render(); };
  $('defaults').onclick = e => { e.preventDefault(); fieldsEl.value = DEFAULT_FIELDS; fieldsEl.onchange(); };
  filterEl.oninput = drawTable;
  $('csv').onclick = exportCsv;
  $('copy').onclick = safe(copyTable);

  try {
    API = await TrimbleConnectWorkspace.connect(window.parent, (event) => {
      if (event === 'viewer.onSelectionChanged') render();
    }, 30000);
  } catch (e) {
    return setStatus('Could not connect to Trimble Connect: ' + (e.message || e));
  }

  setStatus('Connected. Select objects in the 3D view.');
  $('colour').onclick = safe(colourBy);
  $('reset').onclick = safe(async () => {
    await API.viewer.setObjectState(undefined, { color: 'reset' });   // undefined = all objects
    setStatus('Colours cleared.');
  });
  $('label').onclick = safe(labelSelected);
  $('clearLabels').onclick = safe(clearLabels);
  render();
})();
