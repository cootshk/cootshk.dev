/* ──────────────────────────────────────────────────────────────────────────
 * Modpack Builder — client-side modpack editor backed by the Modrinth API.
 * Depends on shared helpers from ../cdn/shared/scripts/util.js
 *   ($, $$, esc, formatDownloads, titleCase, computeSha1)
 * and JSZip (loaded via CDN in index.html).
 * ────────────────────────────────────────────────────────────────────────── */

const API = 'https://api.modrinth.com/v2';
const API3 = 'https://api.modrinth.com/v3'; // search only — handles current game versions that v2 500s on

// Loaders offered when creating a pack. `depKey` is the key Modrinth's .mrpack
// format uses under `dependencies`; the loader id doubles as the search facet
// category and the `loaders` query value.
const LOADERS = {
  fabric:   { label: 'Fabric',   depKey: 'fabric-loader' },
  neoforge: { label: 'NeoForge', depKey: 'neoforge' },
  forge:    { label: 'Forge',    depKey: 'forge' },
  quilt:    { label: 'Quilt',    depKey: 'quilt-loader' },
};

// ── localStorage persistence ──────────────────────────────────────────────
const INDEX_KEY = 'modpack:index';
const packKey = id => `modpack:pack:${id}`;

function loadIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; }
  catch { return []; }
}
function loadPack(id) {
  try { return JSON.parse(localStorage.getItem(packKey(id))); }
  catch { return null; }
}
function savePack(pack) {
  localStorage.setItem(packKey(pack.id), JSON.stringify(pack));
  const index = loadIndex().filter(p => p.id !== pack.id);
  index.unshift({
    id: pack.id, name: pack.name, loader: pack.loader,
    mcVersion: pack.mcVersion, modCount: pack.mods.length, updated: Date.now(),
  });
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}
function deletePack(id) {
  localStorage.removeItem(packKey(id));
  localStorage.setItem(INDEX_KEY, JSON.stringify(loadIndex().filter(p => p.id !== id)));
}

// ── App state ──────────────────────────────────────────────────────────────
let currentPack = null;            // pack open in the editor
let searchTimer = null;
let searchToken = 0;               // guards against out-of-order search responses

// ── Small UI helpers ─────────────────────────────────────────────────────
function showLoading(msg) {
  $('#loading-text').textContent = msg || 'Working…';
  $('#loading').classList.remove('hidden');
}
function hideLoading() { $('#loading').classList.add('hidden'); }

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
}

const encArr = arr => encodeURIComponent(JSON.stringify(arr));
const modrinthIcon = () => '<div class="pack-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>';

function normalizeEnv(side) {
  return side === 'unsupported' ? 'unsupported' : side === 'optional' ? 'optional' : 'required';
}

// ── View routing ────────────────────────────────────────────────────────────
function goHome() {
  currentPack = null;
  $('#editor-view').classList.add('hidden');
  $('#home-view').classList.remove('hidden');
  $('#nav-pack-label').classList.add('hidden');
  renderPackList();
}
window.goHome = goHome;

async function openEditor(pack) {
  currentPack = pack;
  $('#home-view').classList.add('hidden');
  $('#editor-view').classList.remove('hidden');
  $('#nav-pack-label').textContent = pack.name;
  $('#nav-pack-label').classList.remove('hidden');
  $('#editor-pack-name').textContent = pack.name;
  $('#editor-pack-meta').textContent =
    `${LOADERS[pack.loader]?.label || pack.loader} · Minecraft ${pack.mcVersion}`;
  $('#mod-search').value = '';
  $('#search-results').innerHTML = '<p class="no-data">Search for mods to add to your pack.</p>';
  refreshEditor();

  // Backfill dependency metadata for mods that lack it (older packs, or imports
  // resolved from file hashes), then re-render with the completed graph.
  if (pack.mods.some(m => m.depsV !== DEPS_VERSION)) {
    showLoading('Resolving dependencies…');
    try { await ensureDepGraph(pack); } catch (e) { console.warn('Dep backfill failed:', e); }
    hideLoading();
    if (currentPack === pack) refreshEditor();
  }
}

// ── Home / pack list ─────────────────────────────────────────────────────────
function renderPackList() {
  const index = loadIndex();
  const list = $('#pack-list');
  if (!index.length) {
    list.innerHTML = `<div class="empty-state">
      <p>No modpacks yet.</p>
      <p>Create one or import a <strong>.mrpack</strong> to get started.</p>
    </div>`;
    return;
  }
  list.innerHTML = index.map(p => `
    <div class="pack-card" data-id="${esc(p.id)}">
      <div class="pack-card-top">
        ${modrinthIcon()}
        <div class="pack-card-info">
          <div class="pack-card-name">${esc(p.name)}</div>
          <div class="pack-card-meta">
            <span class="loader-badge">${esc(LOADERS[p.loader]?.label || p.loader)}</span>
            ${esc(p.mcVersion)} · ${p.modCount} mod${p.modCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div class="pack-card-actions">
        <button class="btn btn-primary btn-sm" data-act="edit">Edit</button>
        <button class="btn btn-secondary btn-sm" data-act="export">Export</button>
        <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
      </div>
    </div>
  `).join('');

  $$('.pack-card', list).forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => {
      const pack = loadPack(id);
      if (pack) openEditor(pack); else toast('Could not load pack', true);
    });
    card.querySelector('[data-act="export"]').addEventListener('click', () => {
      const pack = loadPack(id);
      if (pack) exportMrpack(pack);
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (confirm('Delete this modpack? This cannot be undone.')) { deletePack(id); renderPackList(); }
    });
  });
}

// ── Minecraft versions (for the New-pack modal) ──────────────────────────────
let gameVersionsPromise = null;
function loadGameVersions() {
  if (!gameVersionsPromise) {
    gameVersionsPromise = fetch(`${API}/tag/game_version`)
      .then(r => r.json())
      .then(data => data.filter(v => v.version_type === 'release')
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(v => v.version))
      .catch(() => []);
  }
  return gameVersionsPromise;
}

// Loader icons (SVG markup) come straight from Modrinth's loader tag.
let loaderIconsPromise = null;
function loadLoaderIcons() {
  if (!loaderIconsPromise) {
    loaderIconsPromise = fetch(`${API}/tag/loader`)
      .then(r => r.json())
      .then(list => Object.fromEntries(list.map(l => [l.name, l.icon])))
      .catch(() => ({}));
  }
  return loaderIconsPromise;
}
async function updateLoaderIcon() {
  const icons = await loadLoaderIcons();
  const loader = $('#loader-select').value;
  const el = $('#loader-icon');
  el.innerHTML = icons[loader] || '';
  // Icons use currentColor; tint with the platform brand color.
  el.style.color = `var(--color-platform-${loader}, var(--text-primary))`;
}

// ── New-pack modal ───────────────────────────────────────────────────────────
function openModal() {
  $('#pack-name-input').value = '';
  $('#loader-select').value = 'fabric';
  $('#loader-icon').innerHTML = '';
  updateLoaderIcon();
  $('#modal-error').classList.add('hidden');
  const mcSel = $('#mc-version-input');
  mcSel.innerHTML = '<option value="">Loading…</option>';
  $('#modal-backdrop').classList.remove('hidden');
  $('#pack-name-input').focus();
  loadGameVersions().then(versions => {
    mcSel.innerHTML = versions.length
      ? versions.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      : '<option value="">Failed to load versions</option>';
  });
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }

async function createPack() {
  const name = $('#pack-name-input').value.trim();
  const loader = $('#loader-select').value;
  const mcVersion = $('#mc-version-input').value;
  const err = $('#modal-error');
  if (!name) { err.textContent = 'Please enter a name.'; err.classList.remove('hidden'); return; }
  if (!mcVersion) { err.textContent = 'Please choose a Minecraft version.'; err.classList.remove('hidden'); return; }

  closeModal();
  showLoading('Setting up pack…');
  const loaderVersion = await resolveLoaderVersion(loader, mcVersion);
  hideLoading();

  const pack = { id: crypto.randomUUID(), name, loader, mcVersion, loaderVersion, mods: [] };
  savePack(pack);
  openEditor(pack);
}

// ── Editor: Modrinth search ─────────────────────────────────────────────────
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 350);
}

async function runSearch() {
  const q = $('#mod-search').value.trim();
  const results = $('#search-results');
  const token = ++searchToken;

  // Use Modrinth's v3 search (what modrinth.com itself uses): its v2 facet
  // search returns 500 for some current game versions, while v3 handles them.
  const filters = [
    `game_versions = \`${currentPack.mcVersion}\``,
    'project_types = `mod`',
    `categories = \`${currentPack.loader}\``,
  ].join(' AND ');
  const params = new URLSearchParams({
    query: q,
    index: $('#sort-select').value,
    limit: '20',
    new_filters: filters,
  });
  results.innerHTML = '<div class="results-loading"><div class="spinner"></div></div>';
  try {
    const res = await fetch(`${API3}/search?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (token !== searchToken) return; // a newer search superseded this one
    renderSearchResults((data.hits || []).map(normalizeHit));
  } catch (e) {
    if (token !== searchToken) return;
    results.innerHTML = `<div class="error-msg">Search failed: ${esc(e.message)}. Please try again.</div>`;
  }
}

// Map a v3 search hit onto the (v2-like) shape the rest of the app expects.
function normalizeHit(h) {
  return {
    project_id: h.project_id,
    slug: h.slug,
    title: h.name,
    description: h.summary,
    icon_url: h.icon_url,
    author: h.author,
    downloads: h.downloads,
    categories: h.categories,
    display_categories: h.display_categories,
    client_side: Array.isArray(h.client_side) ? h.client_side[0] : h.client_side,
    server_side: Array.isArray(h.server_side) ? h.server_side[0] : h.server_side,
  };
}

function renderSearchResults(hits) {
  const results = $('#search-results');
  if (!hits.length) { results.innerHTML = '<p class="no-data">No mods found.</p>'; return; }
  const installed = new Set(currentPack.mods.map(m => m.projectId));

  results.innerHTML = hits.map(h => {
    const added = installed.has(h.project_id);
    const tags = (h.display_categories || h.categories || [])
      .filter(c => !(c in LOADERS)).slice(0, 3)
      .map(c => `<span class="tag-chip">${esc(c)}</span>`).join('');
    return `
      <div class="search-result" data-id="${esc(h.project_id)}">
        ${h.icon_url
          ? `<img class="result-icon" src="${esc(h.icon_url)}" alt="" loading="lazy">`
          : `<div class="result-icon placeholder">&#x1f4e6;</div>`}
        <div class="result-body">
          <div class="result-title-row">
            <span class="result-name">${esc(h.title)}</span>
            <span class="result-author">by ${esc(h.author)}</span>
          </div>
          <div class="result-desc">${esc(h.description)}</div>
          <div class="result-meta-row">
            ${tags}
            <span>&#x2193; ${formatDownloads(h.downloads)}</span>
          </div>
        </div>
        <button class="btn ${added ? 'btn-secondary result-add added' : 'btn-primary result-add'} btn-sm" data-add="${esc(h.project_id)}">
          ${added ? 'Added' : 'Add'}
        </button>
      </div>`;
  }).join('');

  $$('.result-add', results).forEach(btn => {
    btn.addEventListener('click', () => onAddClick(btn.dataset.add, hits.find(h => h.project_id === btn.dataset.add)));
  });
}

async function onAddClick(projectId, hit) {
  if (currentPack.mods.some(m => m.projectId === projectId)) { toast('Already in your pack'); return; }
  showLoading('Resolving mod & dependencies…');
  try {
    const added = await addModByProject(projectId, { hit, asDep: false, visited: new Set() });
    if (added) {
      savePack(currentPack);
      refreshEditor();
      toast('Added to pack');
    }
  } catch (e) {
    toast('Failed: ' + e.message, true);
  } finally {
    hideLoading();
  }
}

// Adds a project (and its required dependencies) to the current pack.
// Returns true if the primary project was added. Dependencies are resolved
// recursively; `visited` guards against cycles.
async function addModByProject(projectId, { hit = null, asDep = false, visited }) {
  if (visited.has(projectId)) return false;
  visited.add(projectId);
  if (currentPack.mods.some(m => m.projectId === projectId)) return false;

  const version = await fetchCompatibleVersion(projectId);
  if (!version) {
    if (!asDep) toast(`No ${LOADERS[currentPack.loader].label} ${currentPack.mcVersion} version available`, true);
    else console.warn('Skipping incompatible dependency', projectId);
    return false;
  }
  const file = version.files.find(f => f.primary) || version.files[0];
  if (!file) return false;

  // Project metadata — reuse the search hit when we have it, else fetch.
  let title, icon, slug, clientSide, serverSide;
  if (hit) {
    ({ title, slug } = hit); icon = hit.icon_url;
    clientSide = hit.client_side; serverSide = hit.server_side;
  } else {
    const proj = await fetchProject(projectId);
    title = proj?.title || file.filename; slug = proj?.slug || null;
    icon = proj?.icon_url || null;
    clientSide = proj?.client_side; serverSide = proj?.server_side;
  }

  const entry = {
    projectId, slug, title, icon,
    versionId: version.id, versionNumber: version.version_number,
    filename: file.filename, url: file.url,
    hashes: file.hashes || {}, fileSize: file.size || 0,
    env: { client: normalizeEnv(clientSide), server: normalizeEnv(serverSide) },
    addedAsDep: asDep,
    requiredDeps: [], // { projectId, title, icon } this mod requires
    optionalDeps: [], // { projectId, title, icon } this mod optionally suggests
    depsV: DEPS_VERSION,
  };
  currentPack.mods.push(entry);

  // Walk dependencies, recording the graph (with metadata) so the installed
  // list can highlight relationships and list each mod's dependencies beneath it.
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' && dep.dependency_type !== 'optional') continue;
    const meta = await resolveDepMeta(dep);
    if (!meta) continue;
    if (dep.dependency_type === 'required') {
      entry.requiredDeps.push(meta);
      await addModByProject(meta.projectId, { asDep: true, visited });
    } else {
      entry.optionalDeps.push(meta);
    }
  }
  return true;
}

async function fetchCompatibleVersion(projectId) {
  const url = `${API}/project/${projectId}/version?loaders=${encArr([currentPack.loader])}&game_versions=${encArr([currentPack.mcVersion])}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const versions = await res.json();
  if (!versions.length) return null;
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  return versions.find(v => v.featured) || versions.find(v => v.version_type === 'release') || versions[0];
}

// Session caches so we never refetch the same project/version (also lets us
// resolve a version-id-only dependency back to its project).
const projectCache = new Map(); // projectId -> project | null
const versionCache = new Map(); // versionId -> version | null

async function fetchProject(id) {
  if (projectCache.has(id)) return projectCache.get(id);
  let proj = null;
  try {
    const res = await fetch(`${API}/project/${id}`);
    proj = res.ok ? await res.json() : null;
  } catch { proj = null; }
  projectCache.set(id, proj);
  return proj;
}

async function fetchVersion(id) {
  if (versionCache.has(id)) return versionCache.get(id);
  let version = null;
  try {
    const res = await fetch(`${API}/version/${id}`);
    version = res.ok ? await res.json() : null;
  } catch { version = null; }
  versionCache.set(id, version);
  return version;
}

// Resolve a Modrinth dependency entry to { projectId, title, icon }. Some
// dependencies specify only a version_id (no project_id) — look up the version
// to recover its project. Returns null if it can't be resolved to a project.
async function resolveDepMeta(dep) {
  let projectId = dep.project_id;
  if (!projectId && dep.version_id) {
    const v = await fetchVersion(dep.version_id);
    projectId = v?.project_id || null;
  }
  if (!projectId) return null;
  const proj = await fetchProject(projectId);
  return { projectId, title: proj?.title || projectId, icon: proj?.icon_url || null };
}

// Rebuild a mod's dependency graph from its installed version. Used to backfill
// packs whose mods lack (or have stale) dependency metadata — including imported
// .mrpack packs, whose mods gain a versionId from the sha1 lookup. Cached, and
// tagged with depsV so it only runs once per mod.
const DEPS_VERSION = 2;
async function resolveModDeps(mod) {
  const req = [], opt = [];
  const version = mod.versionId ? await fetchVersion(mod.versionId) : null;
  for (const dep of version?.dependencies || []) {
    if (dep.dependency_type !== 'required' && dep.dependency_type !== 'optional') continue;
    const meta = await resolveDepMeta(dep);
    if (!meta) continue;
    (dep.dependency_type === 'required' ? req : opt).push(meta);
  }
  mod.requiredDeps = req;
  mod.optionalDeps = opt;
  mod.depsV = DEPS_VERSION;
}

async function ensureDepGraph(pack) {
  const pending = pack.mods.filter(m => m.depsV !== DEPS_VERSION);
  if (!pending.length) return false;
  for (const mod of pending) await resolveModDeps(mod);
  savePack(pack);
  return true;
}

// ── Editor: installed list + optional strip ──────────────────────────────────
function refreshEditor() {
  const list = $('#installed-list');
  const mods = currentPack.mods;
  $('#installed-count').textContent = mods.length;

  // Build the dependency graph across currently-installed mods: which projects
  // are required (yellow) or optionally suggested (blue) by another installed mod.
  const installedIds = new Set(mods.map(m => m.projectId));
  const requiredBy = new Map(); // projectId -> title of a mod that requires it
  const optionalBy = new Map(); // projectId -> title of a mod that optionally wants it
  for (const m of mods) {
    for (const d of m.requiredDeps || []) if (!requiredBy.has(d.projectId)) requiredBy.set(d.projectId, m.title);
    for (const d of m.optionalDeps || []) if (!optionalBy.has(d.projectId)) optionalBy.set(d.projectId, m.title);
  }

  // A dependency row shown beneath the mod that declares it.
  const depRow = (d, kind) => `
    <div class="mod-dep mod-dep-${kind}">
      ${d.icon
        ? `<img class="mod-dep-icon" src="${esc(d.icon)}" alt="">`
        : `<div class="mod-dep-icon placeholder">&#x1f4e6;</div>`}
      <span class="mod-dep-name">${esc(d.title)}</span>
      <span class="mod-dep-label">${kind === 'required' ? 'missing required' : 'optional'}</span>
      <button class="btn ${kind === 'required' ? 'btn-primary' : 'btn-secondary'} btn-sm mod-dep-add" data-add-dep="${esc(d.projectId)}">Add</button>
    </div>`;

  if (!mods.length) {
    list.innerHTML = '<p class="no-data">No mods yet. Add some from the search on the left.</p>';
  } else {
    list.innerHTML = mods.map((m, i) => {
      const reqBy = requiredBy.get(m.projectId);
      const optBy = !reqBy ? optionalBy.get(m.projectId) : null; // required takes precedence
      const roleClass = reqBy ? 'dep-required' : optBy ? 'dep-optional' : '';
      const tag = reqBy
        ? `<span class="dep-tag dep-tag-required">required by ${esc(reqBy)}</span>`
        : optBy
          ? `<span class="dep-tag dep-tag-optional">optional for ${esc(optBy)}</span>`
          : '';

      // Dependencies of this mod that aren't currently installed.
      const missingReq = (m.requiredDeps || []).filter(d => !installedIds.has(d.projectId));
      const missingOpt = (m.optionalDeps || []).filter(d => !installedIds.has(d.projectId));
      const deps = missingReq.map(d => depRow(d, 'required')).join('') + missingOpt.map(d => depRow(d, 'optional')).join('');

      return `
      <div class="installed-entry">
        <div class="installed-item ${roleClass}">
          ${m.icon
            ? `<img class="installed-icon" src="${esc(m.icon)}" alt="">`
            : `<div class="installed-icon placeholder">&#x1f4e6;</div>`}
          <div class="installed-body">
            <div class="installed-name">${esc(m.title)}</div>
            <div class="installed-sub">
              ${m.versionNumber ? esc(m.versionNumber) : esc(m.filename)}
              ${tag ? ' · ' + tag : ''}
            </div>
          </div>
          <button class="icon-btn danger" data-remove="${i}" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        ${deps ? `<div class="mod-deps">${deps}</div>` : ''}
      </div>`;
    }).join('');

    $$('[data-remove]', list).forEach(btn => {
      btn.addEventListener('click', () => removeMod(+btn.dataset.remove));
    });
    $$('[data-add-dep]', list).forEach(btn => {
      btn.addEventListener('click', () => addDependency(btn.dataset.addDep));
    });
  }
  syncSearchButtons();
}

// Add a dependency (required or optional) surfaced beneath a mod.
async function addDependency(projectId) {
  showLoading('Adding…');
  try {
    await addModByProject(projectId, { asDep: true, visited: new Set() });
    savePack(currentPack);
    refreshEditor();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  } finally {
    hideLoading();
  }
}

function removeMod(index) {
  currentPack.mods.splice(index, 1);
  savePack(currentPack);
  refreshEditor();
}

// Reflect installed state onto any currently-rendered search result buttons.
function syncSearchButtons() {
  const installed = new Set(currentPack.mods.map(m => m.projectId));
  $$('.result-add').forEach(btn => {
    const added = installed.has(btn.dataset.add);
    btn.classList.toggle('added', added);
    btn.classList.toggle('btn-primary', !added);
    btn.classList.toggle('btn-secondary', added);
    btn.textContent = added ? 'Added' : 'Add';
  });
}

// ── Loader version resolution ────────────────────────────────────────────────
// Each branch is best-effort; on any network/CORS failure it returns '' and the
// pack still works (the .mrpack just ships without a pinned loader version).
async function resolveLoaderVersion(loader, mc) {
  try {
    if (loader === 'fabric') {
      const data = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
      const stable = data.find(x => (x.loader?.stable ?? x.stable));
      const pick = stable || data[0];
      return pick?.loader?.version || pick?.version || '';
    }
    if (loader === 'quilt') {
      const data = await (await fetch('https://meta.quiltmc.org/v3/versions/loader')).json();
      return data[0]?.version || '';
    }
    if (loader === 'neoforge') {
      // NeoForge maps 1.<minor>.<patch> to <minor>.<patch>.x (e.g. 1.21.1 -> 21.1.x).
      // The maven API's latest-version endpoint is CORS-enabled (the raw
      // maven-metadata.xml is not).
      const [, minor = '0', patch] = mc.split('.');
      const res = await fetch(`https://maven.neoforged.net/api/maven/latest/version/releases/net/neoforged/neoforge?filter=${minor}.${patch || 0}.`);
      if (!res.ok) return ''; // e.g. 1.20.1, which predates this version scheme
      return (await res.json()).version || '';
    }
    if (loader === 'forge') {
      // Forge maven-metadata is CORS-enabled; versions read "<mc>-<forge>" in
      // ascending order, and .mrpack wants just the "<forge>" part.
      const xml = await (await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml')).text();
      const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map(m => m[1]).filter(v => v.startsWith(`${mc}-`));
      const latest = matches[matches.length - 1];
      return latest ? latest.slice(mc.length + 1) : '';
    }
  } catch (e) {
    console.warn('Loader version lookup failed:', e);
  }
  return '';
}

// ── Exports ──────────────────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Keep the anchor + object URL alive briefly so the download settles before
  // teardown (immediate removal can abort larger downloads in some browsers).
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10000);
}

const safeName = name => (name || 'modpack').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'modpack';

async function exportMrpack(pack) {
  pack = pack || currentPack;
  if (!pack.mods.length) { toast('Pack is empty', true); return; }
  showLoading('Building .mrpack…');
  try {
    let loaderVersion = pack.loaderVersion;
    if (!loaderVersion) {
      loaderVersion = await resolveLoaderVersion(pack.loader, pack.mcVersion);
      if (loaderVersion && pack === currentPack) { pack.loaderVersion = loaderVersion; savePack(pack); }
    }
    const dependencies = { minecraft: pack.mcVersion };
    if (loaderVersion) dependencies[LOADERS[pack.loader].depKey] = loaderVersion;

    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0.0',
      name: pack.name,
      files: pack.mods.map(m => ({
        path: `mods/${m.filename}`,
        hashes: m.hashes,
        env: m.env || { client: 'required', server: 'required' },
        downloads: [m.url],
        fileSize: m.fileSize,
      })),
      dependencies,
    };
    const zip = new JSZip();
    zip.file('modrinth.index.json', JSON.stringify(index, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeName(pack.name)}.mrpack`);
    if (!loaderVersion) toast('Exported, but could not resolve the loader version — set it in your launcher.', true);
  } catch (e) {
    toast('Export failed: ' + e.message, true);
  } finally {
    hideLoading();
  }
}

async function exportZip() {
  if (!currentPack.mods.length) { toast('Pack is empty', true); return; }
  const zip = new JSZip();
  const failed = [];
  for (let i = 0; i < currentPack.mods.length; i++) {
    const m = currentPack.mods[i];
    showLoading(`Downloading jars… (${i + 1}/${currentPack.mods.length})`);
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zip.file(`mods/${m.filename}`, await res.blob());
    } catch {
      failed.push(m.filename);
    }
  }
  showLoading('Packing .zip…');
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeName(currentPack.name)}.zip`);
    if (failed.length) toast(`${failed.length} jar(s) could not be fetched (CORS) and were skipped.`, true);
  } catch (e) {
    toast('Zip failed: ' + e.message, true);
  } finally {
    hideLoading();
  }
}

async function exportEach() {
  if (!currentPack.mods.length) { toast('Pack is empty', true); return; }
  for (const m of currentPack.mods) {
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error();
      downloadBlob(await res.blob(), m.filename);
    } catch {
      window.open(m.url, '_blank'); // non-CORS fallback
    }
    await new Promise(r => setTimeout(r, 400)); // let the browser queue each download
  }
}

// ── Import .mrpack ───────────────────────────────────────────────────────────
async function importFile(file) {
  showLoading('Reading modpack…');
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const idxFile = zip.file('modrinth.index.json');
    if (!idxFile) throw new Error('Missing modrinth.index.json — not a Modrinth .mrpack');
    const idx = JSON.parse(await idxFile.async('string'));
    const deps = idx.dependencies || {};

    let loader = 'fabric', loaderVersion = '';
    for (const [id, cfg] of Object.entries(LOADERS)) {
      if (deps[cfg.depKey]) { loader = id; loaderVersion = deps[cfg.depKey]; break; }
    }

    const mods = (idx.files || [])
      .filter(f => f.path && /\.jar$/i.test(f.path))
      .map(f => ({
        projectId: null, slug: null, title: f.path.split('/').pop(), icon: null,
        versionId: null, versionNumber: null,
        filename: f.path.split('/').pop(),
        url: (f.downloads || [])[0] || '',
        hashes: f.hashes || {}, fileSize: f.fileSize || 0,
        env: f.env || { client: 'required', server: 'required' },
        addedAsDep: false,
      }));

    await enrichFromHashes(mods); // best-effort: fill in title/icon/project from Modrinth

    const pack = {
      id: crypto.randomUUID(),
      name: idx.name || file.name.replace(/\.mrpack$/i, '') || 'Imported pack',
      loader, mcVersion: deps.minecraft || '', loaderVersion, mods,
    };
    savePack(pack);
    hideLoading();
    openEditor(pack);
    toast(`Imported "${pack.name}" (${mods.length} mods)`);
  } catch (e) {
    hideLoading();
    toast('Import failed: ' + e.message, true);
  }
}

// Look up imported files on Modrinth by sha1 to recover project id/title/icon.
async function enrichFromHashes(mods) {
  const bySha = new Map();
  for (const m of mods) if (m.hashes?.sha1) bySha.set(m.hashes.sha1, m);
  if (!bySha.size) return;
  try {
    const res = await fetch(`${API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [...bySha.keys()], algorithm: 'sha1' }),
    });
    if (!res.ok) return;
    const data = await res.json(); // { sha1: version }
    const projectIds = new Set();
    for (const [sha, version] of Object.entries(data)) {
      const mod = bySha.get(sha);
      if (!mod) continue;
      mod.projectId = version.project_id;
      mod.versionId = version.id;
      mod.versionNumber = version.version_number;
      projectIds.add(version.project_id);
    }
    if (!projectIds.size) return;
    const projRes = await fetch(`${API}/projects?ids=${encArr([...projectIds])}`);
    if (!projRes.ok) return;
    const projById = new Map((await projRes.json()).map(p => [p.id, p]));
    for (const m of mods) {
      const p = m.projectId && projById.get(m.projectId);
      if (p) { m.title = p.title; m.icon = p.icon_url; m.slug = p.slug; }
    }
  } catch (e) {
    console.warn('Hash enrichment failed:', e);
  }
}

// ── Wire up events ───────────────────────────────────────────────────────────
$('#btn-new').addEventListener('click', openModal);
$('#loader-select').addEventListener('change', updateLoaderIcon);
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-create').addEventListener('click', createPack);
$('#modal-backdrop').addEventListener('click', e => { if (e.target === $('#modal-backdrop')) closeModal(); });
$('#pack-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') createPack(); });

$('#btn-import').addEventListener('click', () => $('#import-input').click());
$('#import-input').addEventListener('change', e => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
});

$('#btn-back').addEventListener('click', goHome);
$('#mod-search').addEventListener('input', scheduleSearch);
$('#sort-select').addEventListener('change', () => { if ($('#mod-search').value.trim() || true) runSearch(); });

$('#btn-export-mrpack').addEventListener('click', () => exportMrpack());
$('#btn-export-zip').addEventListener('click', exportZip);
$('#btn-export-each').addEventListener('click', exportEach);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal();
});

// ── Boot ─────────────────────────────────────────────────────────────────────
renderPackList();
