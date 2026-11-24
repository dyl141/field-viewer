// Field Viewer – Trimble Connect 3D Viewer extension
// FIRST DRAFT – UNTESTED. Checked against trimble-connect-workspace-api v0.3.40 type definitions.

let API;
const out = document.getElementById('out');
const statusEl = document.getElementById('status');
const fieldsEl = document.getElementById('fields');
const CHUNK = 1000; // object IDs per getObjectProperties call (keeps requests small on big models)

const wanted = () => fieldsEl.value.split(',').map(s => s.trim()).filter(Boolean);
const setStatus = t => { statusEl.textContent = t; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ObjectProperties.properties is PropertySet[]; each set has name + properties: Property[] {name, value}
// Flatten to { "Set.Prop": value, "Prop": value } – bare name keeps the FIRST match.
function flatten(obj) {
  const m = {};
  (obj.properties || []).forEach(set => {
    (set.properties || []).forEach(p => {
      m[`${set.name}.${p.name}`] = p.value;
      if (!(p.name in m)) m[p.name] = p.value;
    });
  });
  return m;
}

// getObjectProperties(modelId, objectRuntimeIds[]) -> ObjectProperties[], fetched in chunks
async function getProps(modelId, ids) {
  const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    all.push(...await API.viewer.getObjectProperties(modelId, ids.slice(i, i + CHUNK)));
  }
  return all;
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;            // ignore stale renders if selection changes quickly
  const f = wanted();
  const sel = await API.viewer.getSelection();   // Selection = ModelObjectIds[]
  let rows = '';
  let count = 0;
  for (const s of sel) {
    if (!s.objectRuntimeIds || !s.objectRuntimeIds.length) continue;
    const props = await getProps(s.modelId, s.objectRuntimeIds);
    props.forEach(o => {
      const m = flatten(o);
      rows += `<tr><td>${esc(o.id)}</td>${f.map(x => `<td>${esc(m[x])}</td>`).join('')}</tr>`;
      count++;
    });
  }
  if (token !== renderToken) return;
  out.innerHTML = count
    ? `<table><tr><th>ID</th>${f.map(x => `<th>${esc(x)}</th>`).join('')}</tr>${rows}</table>`
    : '<i>Select objects in the 3D view.</i>';
  setStatus(`${count} object(s) selected`);
}

// Stable string hash -> ColorRGBA {r,g,b,a} (0-255)
function colourFor(v) {
  let h = 0;
  for (const c of String(v)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255, a: 255 };
}

async function colourBy() {
  const field = wanted()[0];
  if (!field) return setStatus('Enter at least one field.');
  setStatus(`Colouring by "${field}"…`);
  const models = await API.viewer.getObjects();   // ModelObjects[] = { modelId, objects: ObjectProperties[] }
  const values = new Set();
  for (const mo of models) {
    const ids = mo.objects.map(o => o.id);
    const props = await getProps(mo.modelId, ids);
    const groups = {};
    props.forEach(o => {
      const v = flatten(o)[field] ?? 'n/a';
      (groups[v] = groups[v] || []).push(o.id);
    });
    for (const [v, rids] of Object.entries(groups)) {
      values.add(v);
      await API.viewer.setObjectState(
        { modelObjectIds: [{ modelId: mo.modelId, objectRuntimeIds: rids }] },
        { color: colourFor(v) });
    }
  }
  setStatus(`Coloured by "${field}" – ${values.size} distinct value(s).`);
}

(async () => {
  try {
    API = await TrimbleConnectWorkspace.connect(window.parent, (event) => {
      if (event === 'viewer.onSelectionChanged') render();
    }, 30000);
    setStatus('Connected. Select objects in the 3D view.');
    document.getElementById('colour').onclick = () => colourBy().catch(e => setStatus('Error: ' + e));
    document.getElementById('reset').onclick = async () => {
      await API.viewer.setObjectState(undefined, { color: 'reset' }); // undefined selector = all objects
      setStatus('Colours cleared.');
    };
    fieldsEl.onchange = render;
    render();
  } catch (e) {
    setStatus('Could not connect to Trimble Connect: ' + e);
  }
})();
