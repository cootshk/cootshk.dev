/* ── Tailor: Fabric Mod Analyzer ── */

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

// ── Navigation stack for drilling into JiJ mods ──
let modStack = []; // stack of parsed mod objects
let modrinthLookup = {}; // sha1 -> { projectId, slug, versionId }
let mcVersions = []; // cached list of Minecraft versions from Modrinth
const VF_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@run-slicer/vf@0.6.3-1.12.0/vf.js';
const MAX_CLASS_CACHE_SIZE = 32;
let vfDecompilePromise = null;

// ── Minecraft / mappings constants (the heavy pipeline lives in mc.js) ──
// Versions at or before this are obfuscated and require mappings; newer ship deobfuscated.
const MC_LAST_OBFUSCATED_VERSION = '1.21.11';
const MC_NAMESPACES = ['loom', 'mojang', 'intermediary'];
const MC_NAMESPACE_LABELS = { loom: 'Yarn (Loom)', mojang: 'Mojang', intermediary: 'Intermediary' };
const MC_NS_STORAGE_KEY = 'tailor-mc-namespace';

// ── Load Minecraft versions from Modrinth on startup ──
(async function loadMcVersions() {
  try {
    const res = await fetch('https://api.modrinth.com/v2/tag/game_version');
    if (!res.ok) return;
    const data = await res.json();
    // Filter to only "release" type and sort by date descending
    mcVersions = data
      .filter(v => v.version_type === 'release')
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const select = $('#mc-version-filter');
    for (const v of mcVersions) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = v.version;
      select.appendChild(opt);
    }
  } catch (_) { /* non-critical */ }
})();

// ── Tab switching ──
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    // Clear search state when switching tabs
    clearSearchState();
  });
});

function clearSearchState() {
  $('#search-results').innerHTML = '';
  $('#version-picker').classList.add('hidden');
  $('#version-picker').innerHTML = '';
}

// ── File upload / drag-drop ──
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) analyzeFile(e.target.files[0]);
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.jar')) analyzeFile(file);
});

// ── Modrinth search ──
let searchTimeout;
const searchInput = $('#modrinth-search');

const mcVersionFilter = $('#mc-version-filter');

function triggerSearch() {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (!q) {
    clearSearchState();
    return;
  }
  searchTimeout = setTimeout(() => searchModrinth(q), 350);
}

searchInput.addEventListener('input', triggerSearch);
mcVersionFilter.addEventListener('change', () => {
  // If we're in the version picker, re-filter versions; otherwise re-search
  if (!$('#version-picker').classList.contains('hidden') && currentPickerSlug) {
    pickProject(currentPickerSlug);
  } else {
    triggerSearch();
  }
});

// Close dropdowns on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    clearSearchState();
    searchInput.value = '';
  }
});

let currentPickerSlug = null; // track which project's versions are shown

async function searchModrinth(query) {
  const results = $('#search-results');
  const versionPicker = $('#version-picker');
  versionPicker.classList.add('hidden');
  versionPicker.innerHTML = '';
  currentPickerSlug = null;
  results.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  try {
    const facetGroups = [['categories:fabric'], ['project_type:mod']];
    const selectedVer = mcVersionFilter.value;
    if (selectedVer) facetGroups.push([`versions:${selectedVer}`]);
    const facets = encodeURIComponent(JSON.stringify(facetGroups));
    const res = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=15`);
    const data = await res.json();

    if (!data.hits || data.hits.length === 0) {
      results.innerHTML = '<p class="no-data">No mods found.</p>';
      return;
    }

    results.innerHTML = `
      <button class="dropdown-close" id="close-search">&times; Close results</button>
      ${data.hits.map(hit => `
        <div class="search-result" data-slug="${hit.slug}" data-id="${hit.project_id}">
          ${hit.icon_url
            ? `<img class="search-result-icon" src="${hit.icon_url}" alt="" loading="lazy">`
            : `<div class="search-result-icon placeholder">&#x1f4e6;</div>`}
          <div class="search-result-info">
            <div class="search-result-name">${esc(hit.title)}</div>
            <div class="search-result-desc">${esc(hit.description)}</div>
          </div>
          <div class="search-result-meta">${formatDownloads(hit.downloads)} downloads</div>
        </div>
      `).join('')}
    `;

    $('#close-search').addEventListener('click', () => {
      results.innerHTML = '';
    });

    $$('.search-result', results).forEach(el => {
      el.addEventListener('click', () => pickProject(el.dataset.slug, el.dataset.id));
    });
  } catch (err) {
    results.innerHTML = `<div class="error-msg">Search failed: ${esc(err.message)}</div>`;
  }
}

let allProjectVersions = []; // cache fetched versions for client-side re-filtering

async function pickProject(slug) {
  const results = $('#search-results');
  const versionPicker = $('#version-picker');
  currentPickerSlug = slug;

  results.innerHTML = '';
  versionPicker.classList.remove('hidden');
  versionPicker.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading versions...</p></div>';

  try {
    const res = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?loaders=["fabric"]`);
    allProjectVersions = await res.json();
    renderVersionPicker();
  } catch (err) {
    versionPicker.innerHTML = `<div class="error-msg">Failed to load versions: ${esc(err.message)}</div>`;
  }
}

function renderVersionPicker() {
  const versionPicker = $('#version-picker');
  const selectedVer = mcVersionFilter.value;

  const filtered = selectedVer
    ? allProjectVersions.filter(v => v.game_versions.includes(selectedVer))
    : allProjectVersions;

  if (!filtered.length && !allProjectVersions.length) {
    versionPicker.innerHTML = '<p class="no-data">No Fabric versions found.</p>';
    return;
  }

  versionPicker.innerHTML = `
    <div class="version-picker-header">
      <button class="back-btn" id="back-to-search">&larr; Back to results</button>
      <button class="dropdown-close" id="close-versions">&times; Close</button>
    </div>
    <h3>Select a version${selectedVer ? ` <span class="version-filter-badge">Minecraft ${esc(selectedVer)}</span>` : ''}</h3>
    ${!filtered.length
      ? `<p class="no-data">No versions match Minecraft ${esc(selectedVer)}. <button class="link-btn" id="clear-ver-filter">Show all versions</button></p>`
      : `<div class="version-list">
        ${filtered.map(v => `
          <div class="version-item" data-url="${v.files.find(f => f.primary)?.url || v.files[0]?.url}" data-filename="${v.files.find(f => f.primary)?.filename || v.files[0]?.filename}">
            <div class="version-item-info">
              <span class="version-number">${esc(v.version_number)}</span>
              <span class="version-type ${v.version_type}">${v.version_type}</span>
              <span class="version-game-versions">${v.game_versions.slice(0, 3).join(', ')}${v.game_versions.length > 3 ? '...' : ''}</span>
            </div>
            <span class="version-downloads">${formatDownloads(v.downloads)}</span>
          </div>
        `).join('')}
      </div>`
    }
  `;

  $('#back-to-search').addEventListener('click', () => {
    versionPicker.classList.add('hidden');
    versionPicker.innerHTML = '';
    currentPickerSlug = null;
    const q = searchInput.value.trim();
    if (q) searchModrinth(q);
  });

  $('#close-versions').addEventListener('click', () => {
    versionPicker.classList.add('hidden');
    versionPicker.innerHTML = '';
    currentPickerSlug = null;
  });

  const clearBtn = $('#clear-ver-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      mcVersionFilter.value = '';
      renderVersionPicker();
    });
  }

  $$('.version-item', versionPicker).forEach(el => {
    el.addEventListener('click', () => downloadAndAnalyze(el.dataset.url, el.dataset.filename));
  });
}

async function downloadAndAnalyze(url, filename) {
  showLoading(`Downloading ${filename}...`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: 'application/java-archive' });
    await analyzeFile(file);
  } catch (err) {
    hideLoading();
    alert('Download failed: ' + err.message);
  }
}

// ── Core analysis ──
async function analyzeFile(file) {
  showLoading('Analyzing mod...');
  try {
    if (modStack.length) {
      modStack.forEach(clearModResources);
    }
    const buf = await file.arrayBuffer();
    const mod = await parseJar(buf, file.name);
    modStack = [mod];
    modrinthLookup = {};

    // Look up all jar SHA1 hashes on Modrinth in the background
    lookupModrinthHashes(mod);

    renderMod(mod);
  } catch (err) {
    hideLoading();
    alert('Analysis failed: ' + err.message);
    console.error(err);
  }
}

async function computeSha1(buffer) {
  const hash = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Java class file major version -> human-readable name
const JAVA_VERSIONS = {
  45: 'Java 1.1', 46: 'Java 1.2', 47: 'Java 1.3', 48: 'Java 1.4',
  49: 'Java 5', 50: 'Java 6', 51: 'Java 7', 52: 'Java 8',
  53: 'Java 9', 54: 'Java 10', 55: 'Java 11', 56: 'Java 12',
  57: 'Java 13', 58: 'Java 14', 59: 'Java 15', 60: 'Java 16',
  61: 'Java 17', 62: 'Java 18', 63: 'Java 19', 64: 'Java 20',
  65: 'Java 21', 66: 'Java 22', 67: 'Java 23', 68: 'Java 24',
  69: 'Java 25',
};

async function parseJar(buffer, filename) {
  const zip = await JSZip.loadAsync(buffer);
  const fmjFile = zip.file('fabric.mod.json');

  if (!fmjFile) {
    throw new Error(`No fabric.mod.json found in ${filename}. This may not be a Fabric mod.`);
  }

  const fmj = JSON.parse(await fmjFile.async('string'));

  // Compute SHA1 of the whole jar
  const sha1 = await computeSha1(buffer);

  // Try to extract icon
  let iconDataUrl = null;
  if (fmj.icon) {
    const iconFile = zip.file(fmj.icon);
    if (iconFile) {
      const iconData = await iconFile.async('base64');
      const ext = fmj.icon.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      iconDataUrl = `data:${mime};base64,${iconData}`;
    }
  }

  // ── Java metadata ──
  const allFiles = Object.keys(zip.files);
  const classEntries = allFiles
    .filter(n => n.endsWith('.class'))
    .map(entry => ({
      entry,
      name: entry.slice(0, -6)
    }));

  // 1) Java bytecode version: read first .class file header
  let javaBytecodeVersion = null;
  const firstClass = allFiles.find(n => n.endsWith('.class'));
  if (firstClass) {
    try {
      const classData = await zip.file(firstClass).async('uint8array');
      // class files: u4 magic (cafebabe), u2 minor, u2 major
      if (classData.length >= 8 && classData[0] === 0xCA && classData[1] === 0xFE && classData[2] === 0xBA && classData[3] === 0xBE) {
        const major = (classData[6] << 8) | classData[7];
        javaBytecodeVersion = { major, label: JAVA_VERSIONS[major] || `Java ${major - 44}` };
      }
    } catch (_) { /* ignore */ }
  }

  // 2) Mixin config files: root-level *.mixins*.json or *mixin*.json files
  const mixinConfigs = allFiles.filter(n => {
    // Must be a root-level JSON file (no directory separators beyond the filename itself)
    if (n.includes('/')) return false;
    if (!n.endsWith('.json')) return false;
    const lower = n.toLowerCase();
    return lower.includes('mixin');
  });

  // 3) Texture Pack detection: assets/ files beyond icon + lang
  const iconPath = fmj.icon || '';
  const assetFiles = allFiles.filter(n => {
    if (!n.startsWith('assets/')) return false;
    if (n.endsWith('/')) return false; // skip directories
    if (n === iconPath) return false;
    // Skip lang files: assets/*/lang/**
    const parts = n.split('/');
    if (parts.length >= 3 && parts[2] === 'lang') return false;
    return true;
  });
  const hasTexturePack = assetFiles.length > 0;

  // Count textures/models/sounds specifically for richer detail
  const textureCount = assetFiles.filter(n => n.includes('/textures/')).length;
  const modelCount = assetFiles.filter(n => n.includes('/models/')).length;
  const soundCount = assetFiles.filter(n => n.includes('/sounds/')).length;
  const shaderCount = assetFiles.filter(n => n.includes('/shaders/')).length;

  // 4) Data Pack detection: data/ folder with actual files
  const dataFiles = allFiles.filter(n => n.startsWith('data/') && !n.endsWith('/'));
  const hasDataPack = dataFiles.length > 0;

  const recipeCount = dataFiles.filter(n => n.includes('/recipes/')).length;
  const lootTableCount = dataFiles.filter(n => n.includes('/loot_tables/')).length;
  const tagCount = dataFiles.filter(n => n.includes('/tags/')).length;
  const advancementCount = dataFiles.filter(n => n.includes('/advancements/')).length;
  const worldgenCount = dataFiles.filter(n => n.includes('/worldgen/')).length;
  const structureCount = dataFiles.filter(n => n.includes('/structures/') || n.includes('/structure/')).length;

  const meta = {
    javaBytecodeVersion,
    mixinConfigs,
    hasTexturePack,
    assetCounts: { total: assetFiles.length, textures: textureCount, models: modelCount, sounds: soundCount, shaders: shaderCount },
    hasDataPack,
    dataCounts: { total: dataFiles.length, recipes: recipeCount, lootTables: lootTableCount, tags: tagCount, advancements: advancementCount, worldgen: worldgenCount, structures: structureCount },
    classFileCount: classEntries.length,
    totalFileCount: allFiles.filter(n => !n.endsWith('/')).length,
  };

  // Parse bundled JiJ mods recursively
  const jars = [];
  if (fmj.jars && Array.isArray(fmj.jars)) {
    for (const jarRef of fmj.jars) {
      const jarPath = jarRef.file;
      const jarFile = zip.file(jarPath);
      if (jarFile) {
        try {
          const jarBuf = await jarFile.async('arraybuffer');
          const nested = await parseJar(jarBuf, jarPath.split('/').pop());
          jars.push(nested);
        } catch (e) {
          // Non-fabric jar (e.g., plain library)
          const jarBuf = await jarFile.async('arraybuffer');
          jars.push({
            filename: jarPath.split('/').pop(),
            sha1: await computeSha1(jarBuf),
            fmj: null,
            icon: null,
            jars: [],
            meta: null,
            error: e.message
          });
        }
      }
    }
  }

  return {
    filename,
    sha1,
    fmj,
    icon: iconDataUrl,
    meta,
    jars,
    classEntries,
    zip
  };
}

async function getVineflowerDecompiler() {
  if (!vfDecompilePromise) {
    vfDecompilePromise = import(VF_MODULE_URL).then(mod => mod.decompile);
  }
  return vfDecompilePromise;
}


async function getClassBytes(mod, className) {
  if (!mod.zip || !mod.classEntries?.length) return null;
  if (!mod.classLookup) {
    mod.classLookup = Object.fromEntries(mod.classEntries.map(item => [item.name, item.entry]));
  }
  if (!mod.classBytesCache) {
    mod.classBytesCache = new Map();
  }

  if (mod.classBytesCache.has(className)) {
    return mod.classBytesCache.get(className);
  }

  const entry = mod.classLookup[className];
  if (!entry) return null;
  const file = mod.zip.file(entry);
  if (!file) return null;
  const bytes = await file.async('uint8array');
  mod.classBytesCache.set(className, bytes);
  if (mod.classBytesCache.size > MAX_CLASS_CACHE_SIZE) {
    const oldest = mod.classBytesCache.keys().next().value;
    mod.classBytesCache.delete(oldest);
  }
  return bytes;
}

async function decompileClassInMod(mod, className) {
  const decompile = await getVineflowerDecompiler();
  if (!mod.classResources) {
    mod.classResources = mod.classEntries.map(item => item.name);
  }
  const result = await decompile([className], {
    resources: mod.classResources,
    source: name => getClassBytes(mod, name),
    options: {
      banner: '// Decompiled with Tailor using Vineflower\n\n'
    }
  });

  const source = result[className];
  if (!source) {
    const modLabel = mod.fmj?.id || mod.filename || mod.sha1;
    throw new Error(`Decompiler did not return source for class: ${className} in ${modLabel}`);
  }
  return source;
}

// ── Modrinth hash lookup ──
function collectHashes(mod) {
  const hashes = [mod.sha1];
  for (const j of mod.jars) {
    hashes.push(...collectHashes(j));
  }
  return hashes.filter(Boolean);
}

async function lookupModrinthHashes(mod) {
  const hashes = collectHashes(mod);
  if (!hashes.length) return;

  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes, algorithm: 'sha1' })
    });

    if (!res.ok) return;
    const data = await res.json();

    // data is { [hash]: versionObject }
    for (const [hash, version] of Object.entries(data)) {
      modrinthLookup[hash] = {
        projectId: version.project_id,
        versionId: version.id
      };
    }

    // Now fetch project slugs for all found project IDs
    const projectIds = [...new Set(Object.values(modrinthLookup).map(v => v.projectId))];
    if (projectIds.length) {
      const projRes = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
      if (projRes.ok) {
        const projects = await projRes.json();
        const slugMap = {};
        for (const p of projects) {
          slugMap[p.id] = p.slug;
        }
        for (const entry of Object.values(modrinthLookup)) {
          entry.slug = slugMap[entry.projectId];
        }
      }
    }

    // Re-render Modrinth buttons now that we have the data
    updateModrinthButtons();
  } catch (e) {
    console.warn('Modrinth hash lookup failed:', e);
  }
}

function updateModrinthButtons() {
  $$('[data-sha1]').forEach(el => {
    const sha1 = el.dataset.sha1;
    const info = modrinthLookup[sha1];
    if (info && info.slug) {
      el.classList.remove('hidden');
      el.href = `https://modrinth.com/mod/${info.slug}`;
    }
  });
}

// ── Rendering ──
function renderMod(mod) {
  hideLoading();
  $('#input-section').style.display = 'none';
  const results = $('#results-section');
  results.classList.remove('hidden');

  const fmj = mod.fmj;
  const modrinthInfo = modrinthLookup[mod.sha1];
  const modrinthUrl = modrinthInfo?.slug ? `https://modrinth.com/mod/${modrinthInfo.slug}` : null;

  // Breadcrumb for navigation
  const breadcrumb = modStack.length > 1
    ? `<div class="breadcrumb">${modStack.map((m, i) => {
        const name = esc(m.fmj.name || m.fmj.id);
        if (i === modStack.length - 1) return `<span class="breadcrumb-current">${name}</span>`;
        return `<button class="breadcrumb-link" onclick="navigateBack(${i})">${name}</button>`;
      }).join('<span class="breadcrumb-sep">/</span>')}</div>`
    : '';

  // Header
  $('#mod-header').innerHTML = `
    ${breadcrumb}
    <div class="mod-header-row">
      ${mod.icon
        ? `<img class="mod-icon" src="${mod.icon}" alt="${esc(fmj.name || fmj.id)}">`
        : `<div class="mod-icon placeholder">&#x1f4e6;</div>`}
      <div class="mod-header-info">
        <h1 class="mod-name">${esc(fmj.name || fmj.id)}</h1>
        <div class="mod-version-id">
          <code>${esc(fmj.id)}</code> &middot; v${esc(fmj.version || '?')}
          &middot; <span class="tag ${envClass(fmj.environment, fmj)}">${envLabel(fmj.environment, fmj)}</span>
        </div>
        <p class="mod-description">${esc(fmj.description || '')}</p>
        <div class="mod-meta-row">
          ${fmj.license ? `<div class="mod-meta-item">${iconSvg('scale')} ${esc(typeof fmj.license === 'string' ? fmj.license : fmj.license.name || JSON.stringify(fmj.license))}</div>` : ''}
          ${fmj.authors?.length ? `<div class="mod-meta-item">${iconSvg('users')} ${fmj.authors.map(a => esc(typeof a === 'string' ? a : a.name)).join(', ')}</div>` : ''}
          ${mod.jars.length ? `<div class="mod-meta-item">${iconSvg('package')} ${mod.jars.length} Bundled Mod${mod.jars.length !== 1 ? 's' : ''}</div>` : ''}
        </div>
        <div class="mod-header-actions">
          <button class="btn btn-secondary" onclick="resetView()">${iconSvg('arrow-left')} Analyze another</button>
          <a class="btn btn-modrinth ${modrinthUrl ? '' : 'hidden'}" href="${modrinthUrl || '#'}" target="_blank" rel="noopener" data-sha1="${mod.sha1}">${iconSvg('modrinth')} View on Modrinth</a>
          ${fmj.contact ? Object.entries(fmj.contact).map(([key, url]) =>
            `<a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener">${iconSvg('external')} ${esc(titleCase(key))}</a>`
          ).join('') : ''}</div>
      </div>
    </div>
  `;

  // Build details
  const grid = $('#mod-details');
  grid.innerHTML = '';

  // ── Row 1: Metadata (full-width) ──
  if (mod.meta) {
    let metaContent = renderJavaMeta(mod.meta);
    if (fmj.accessWidener) {
      metaContent += `<div class="meta-detail"><h4>Access Widener</h4><div class="mixin-list"><div class="mixin-item"><span class="mixin-name">${esc(fmj.accessWidener)}</span></div></div></div>`;
    }
    grid.innerHTML += detailCard('Metadata', iconSvg('cpu'), metaContent, 'full-width', 'row-1');
  }

  // ── Row 1.5: Class Decompiler ──
  if (mod.classEntries?.length) {
    grid.innerHTML += detailCard('Class Decompiler', iconSvg('file-code'), renderDecompilerPanel(mod), 'full-width', 'row-1b');
  }

  // ── Row 2: Dependencies / Breaks ──
  if (fmj.depends && Object.keys(fmj.depends).length) {
    grid.innerHTML += detailCard('Dependencies', iconSvg('link'), renderDepList(fmj.depends), '', 'row-2');
  }

  if (fmj.breaks && Object.keys(fmj.breaks).length) {
    grid.innerHTML += detailCard('Breaks / Incompatibilities', iconSvg('alert'), renderBreakList(fmj.breaks), '', 'row-2');
  }

  // ── Row 3: Entrypoints / Mixins ──
  if (fmj.entrypoints && Object.keys(fmj.entrypoints).length) {
    grid.innerHTML += detailCard('Entrypoints', iconSvg('play'), renderEntrypoints(fmj.entrypoints), '', 'row-3');
  }

  if (fmj.mixins?.length) {
    grid.innerHTML += detailCard('Mixins', iconSvg('layers'), renderMixins(fmj.mixins), '', 'row-3');
  }

  // ── Row 4: Bundled Mods ──
  if (mod.jars.length) {
    grid.innerHTML += detailCard(
      `Bundled Mods (Jar-in-Jar) &mdash; ${mod.jars.length}`,
      iconSvg('package'),
      `<div class="jar-list">${mod.jars.map((j, i) => renderJarItem(j, i)).join('')}</div>`,
      'full-width',
      'row-4'
    );
  }

  // Setup expand toggles and buttons
  setupJarToggles();
  setupViewFullButtons();
  setupDecompilerButtons();
  setupCollapsibles();
  updateModrinthButtons();
}

function renderJarItem(mod, index, depth = 0) {
  if (!mod.fmj) {
    const modrinthInfo = modrinthLookup[mod.sha1];
    const modrinthUrl = modrinthInfo?.slug ? `https://modrinth.com/mod/${modrinthInfo.slug}` : null;
    return `
      <div class="jar-item">
        <div class="jar-item-header">
          <div style="width:16px"></div>
          <div class="jar-item-icon placeholder">&#x1f4e6;</div>
          <div class="jar-item-info">
            <div class="jar-item-name">${esc(mod.filename)}</div>
            <div class="jar-item-id" style="color:var(--text-muted)">${esc(mod.error || 'Not a Fabric mod')}</div>
          </div>
          <a class="btn-icon btn-modrinth-sm ${modrinthUrl ? '' : 'hidden'}" href="${modrinthUrl || '#'}" target="_blank" rel="noopener" data-sha1="${mod.sha1}" title="View on Modrinth" onclick="event.stopPropagation()">${iconSvg('modrinth')}</a>
        </div>
      </div>
    `;
  }

  const fmj = mod.fmj;
  const hasDeps = fmj.depends && Object.keys(fmj.depends).length;
  const hasEntries = fmj.entrypoints && Object.keys(fmj.entrypoints).length;
  const hasMixins = fmj.mixins?.length;
  const hasJars = mod.jars.length > 0;
  const hasMeta = mod.meta != null;
  const expandable = hasDeps || hasEntries || hasMixins || hasJars || fmj.description;

  const modrinthInfo = modrinthLookup[mod.sha1];
  const modrinthUrl = modrinthInfo?.slug ? `https://modrinth.com/mod/${modrinthInfo.slug}` : null;

  // Store mod reference for "View full details" button
  const modId = `jij-${mod.sha1}`;

  // Compact meta tags for the jar header line
  const metaTags = mod.meta ? renderCompactMeta(mod.meta) : '';

  return `
    <div class="jar-item" id="${modId}">
      <div class="jar-item-header" ${expandable ? 'data-expandable' : ''}>
        ${expandable ? `<svg class="jar-expand-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>` : '<div style="width:16px"></div>'}
        ${mod.icon
          ? `<img class="jar-item-icon" src="${mod.icon}" alt="">`
          : `<div class="jar-item-icon placeholder">&#x1f4e6;</div>`}
        <div class="jar-item-info">
          <div class="jar-item-name">${esc(fmj.name || fmj.id)}</div>
          <div class="jar-item-id">${esc(fmj.id)} &middot; <span class="tag ${envClass(fmj.environment, fmj)}" style="font-size:0.7rem">${envLabel(fmj.environment, fmj)}</span>${metaTags}</div>
        </div>
        <div class="jar-item-actions">
          <a class="btn-icon btn-modrinth-sm ${modrinthUrl ? '' : 'hidden'}" href="${modrinthUrl || '#'}" target="_blank" rel="noopener" data-sha1="${mod.sha1}" title="View on Modrinth" onclick="event.stopPropagation()">${iconSvg('modrinth')}</a>
          <button class="btn-icon btn-view-full" data-mod-sha1="${mod.sha1}" title="View full details" onclick="event.stopPropagation()">${iconSvg('maximize')}</button>
          <span class="jar-item-version">${esc(fmj.version || '?')}</span>
        </div>
      </div>
      ${expandable ? `
        <div class="jar-item-body">
          ${fmj.description ? `<p style="font-size:0.84rem;color:var(--text-secondary);margin-bottom:8px">${esc(fmj.description)}</p>` : ''}
          ${hasMeta ? `<div class="jar-detail-section"><h4>Java Metadata</h4>${renderJavaMeta(mod.meta)}</div>` : ''}
          ${hasDeps ? `<div class="jar-detail-section"><h4>Dependencies</h4>${renderDepList(fmj.depends)}</div>` : ''}
          ${hasEntries ? `<div class="jar-detail-section"><h4>Entrypoints</h4>${renderEntrypoints(fmj.entrypoints)}</div>` : ''}
          ${hasMixins ? `<div class="jar-detail-section"><h4>Mixins</h4>${renderMixins(fmj.mixins)}</div>` : ''}
          ${hasJars ? `<div class="jar-detail-section"><h4>Nested Bundled Mods (${mod.jars.length})</h4><div class="nested-jars jar-list">${mod.jars.map((j, i) => renderJarItem(j, i, depth + 1)).join('')}</div></div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function setupCollapsibles() {
  $$('.detail-card-header').forEach(header => {
    if (header.dataset.bound) return;
    header.dataset.bound = '1';
    header.addEventListener('click', () => {
      const card = header.closest('.collapsible');
      const isExpanded = card.classList.contains('expanded');
      // Toggle this card
      card.classList.toggle('expanded');
      // Sync siblings on the same row
      const row = card.dataset.row;
      if (row) {
        $$(`[data-row="${row}"]`).forEach(sibling => {
          if (sibling !== card) {
            sibling.classList.toggle('expanded', !isExpanded);
          }
        });
      }
    });
  });
}

function setupJarToggles() {
  $$('[data-expandable]').forEach(header => {
    // Avoid re-attaching by marking
    if (header.dataset.bound) return;
    header.dataset.bound = '1';
    header.addEventListener('click', (e) => {
      // Stop bubbling so clicking a nested header doesn't toggle ancestors
      e.stopPropagation();
      header.closest('.jar-item').classList.toggle('expanded');
    });
  });
}

// Find a mod by sha1 in the tree
function findModBySha1(mod, sha1) {
  if (mod.sha1 === sha1) return mod;
  for (const j of mod.jars) {
    const found = findModBySha1(j, sha1);
    if (found) return found;
  }
  return null;
}

function findModInStackBySha1(sha1) {
  for (let i = modStack.length - 1; i >= 0; i--) {
    const found = findModBySha1(modStack[i], sha1);
    if (found) return found;
  }
  return null;
}

function clearModResources(mod) {
  if (!mod) return;
  mod.classBytesCache?.clear();
  mod.classBytesCache = null;
  mod.classLookup = null;
  mod.classResources = null;
  mod.zip = null;
  mod.classEntries = null;
  if (mod.jars?.length) {
    mod.jars.forEach(clearModResources);
  }
}

function setupViewFullButtons() {
  $$('.btn-view-full').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const sha1 = btn.dataset.modSha1;
      const rootMod = modStack[0];
      const targetMod = findModBySha1(rootMod, sha1);
      if (targetMod) {
        modStack.push(targetMod);
        renderMod(targetMod);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });
}

window.navigateBack = function(index) {
  modStack = modStack.slice(0, index + 1);
  renderMod(modStack[modStack.length - 1]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function renderCompactMeta(meta) {
  const tags = [];
  if (meta.javaBytecodeVersion) {
    tags.push(`<span class="tag-compact tag-compact-blue">${esc(meta.javaBytecodeVersion.label)}</span>`);
  }
  if (meta.mixinConfigs.length) {
    tags.push(`<span class="tag-compact tag-compact-purple">Mixins</span>`);
  }
  if (meta.hasTexturePack) {
    tags.push(`<span class="tag-compact tag-compact-green">Textures</span>`);
  }
  if (meta.hasDataPack) {
    tags.push(`<span class="tag-compact tag-compact-orange">Data</span>`);
  }
  return tags.length ? ' &middot; ' + tags.join(' ') : '';
}

function renderJavaMeta(meta) {
  const pills = [];

  // Java bytecode version
  if (meta.javaBytecodeVersion) {
    pills.push(`<div class="meta-pill meta-pill-blue">${iconSvg('cpu')} <strong>${esc(meta.javaBytecodeVersion.label)}</strong> <span class="meta-pill-sub">Bytecode v${meta.javaBytecodeVersion.major}</span></div>`);
  }

  // Class file count
  if (meta.classFileCount) {
    pills.push(`<div class="meta-pill">${iconSvg('file-code')} ${meta.classFileCount.toLocaleString()} Class Files</div>`);
  }

  // Total files
  pills.push(`<div class="meta-pill">${iconSvg('archive')} ${meta.totalFileCount.toLocaleString()} Total Files</div>`);

  // Mixins
  if (meta.mixinConfigs.length > 0) {
    pills.push(`<div class="meta-pill meta-pill-purple">${iconSvg('layers')} ${meta.mixinConfigs.length} Mixin Config${meta.mixinConfigs.length !== 1 ? 's' : ''}</div>`);
  } else {
    pills.push(`<div class="meta-pill meta-pill-dim">${iconSvg('layers')} No mixins</div>`);
  }

  // Texture Pack
  if (meta.hasTexturePack) {
    const parts = [];
    const ac = meta.assetCounts;
    if (ac.textures) parts.push(`${ac.textures} textures`);
    if (ac.models) parts.push(`${ac.models} models`);
    if (ac.sounds) parts.push(`${ac.sounds} sounds`);
    if (ac.shaders) parts.push(`${ac.shaders} shaders`);
    const detail = parts.length ? parts.join(', ') : `${ac.total} files`;
    pills.push(`<div class="meta-pill meta-pill-green">${iconSvg('image')} Texture Pack <span class="meta-pill-sub">${detail}</span></div>`);
  } else {
    pills.push(`<div class="meta-pill meta-pill-dim">${iconSvg('image')} No texture pack</div>`);
  }

  // Data Pack
  if (meta.hasDataPack) {
    const parts = [];
    const dc = meta.dataCounts;
    if (dc.recipes) parts.push(`${dc.recipes} recipes`);
    if (dc.tags) parts.push(`${dc.tags} tags`);
    if (dc.lootTables) parts.push(`${dc.lootTables} loot tables`);
    if (dc.advancements) parts.push(`${dc.advancements} advancements`);
    if (dc.worldgen) parts.push(`${dc.worldgen} worldgen`);
    if (dc.structures) parts.push(`${dc.structures} structures`);
    const detail = parts.length ? parts.join(', ') : `${dc.total} files`;
    pills.push(`<div class="meta-pill meta-pill-orange">${iconSvg('database')} Data Pack <span class="meta-pill-sub">${detail}</span></div>`);
  } else {
    pills.push(`<div class="meta-pill meta-pill-dim">${iconSvg('database')} No data pack</div>`);
  }

  // Mixin config file names (expandable detail)
  let mixinDetail = '';
  if (meta.mixinConfigs.length) {
    mixinDetail = `<div class="meta-detail"><h4>Mixin config files</h4><div class="mixin-list">${meta.mixinConfigs.map(m => `
      <div class="mixin-item"><span class="mixin-name">${esc(m)}</span></div>
    `).join('')}</div></div>`;
  }

  return `<div class="meta-pills">${pills.join('')}</div>${mixinDetail}`;
}

function renderDecompilerPanel(mod) {
  const detectedMinecraftVersion = detectMinecraftVersion(mod.fmj);
  const fallbackMinecraftVersion = mcVersions[0]?.version || '';
  const activeMinecraftVersion = detectedMinecraftVersion || fallbackMinecraftVersion;
  const versionOptions = mcVersions.map(v =>
    `<option value="${esc(v.version)}"${v.version === activeMinecraftVersion ? ' selected' : ''}>${esc(v.version)}</option>`
  ).join('');

  const env = mcEnvironmentFor(mod.fmj);
  // The mappings dropdown is always available; for deobfuscated builds the
  // loader simply falls back to decompiling the (already readable) jar.
  const namespace = mcPickNamespace(activeMinecraftVersion);
  const mappingOptions = MC_NAMESPACES.map(ns =>
    `<option value="${ns}"${ns === namespace ? ' selected' : ''}>${esc(MC_NAMESPACE_LABELS[ns])}</option>`
  ).join('');

  return `
    <div class="decompiler-panel" data-mod-sha1="${mod.sha1}" data-mc-version="${esc(activeMinecraftVersion)}"
         data-mc-env="${esc(env.join(','))}" data-mc-namespace="${esc(namespace)}" data-view-kind="mod">
      <div class="decompiler-controls">
        <button class="btn btn-secondary btn-explore-classes" data-mod-sha1="${mod.sha1}">${iconSvg('file-code')} explore classes</button>
        ${detectedMinecraftVersion
          ? `<span class="decompiler-mc-version">Minecraft ${esc(detectedMinecraftVersion)}</span>`
          : `<label class="decompiler-mc-picker">Minecraft
              <select class="decompiler-mc-select">
                ${versionOptions}
              </select>
            </label>`}
        <label class="decompiler-mapping-picker">Mappings
          <select class="decompiler-mapping-select">
            ${mappingOptions}
          </select>
        </label>
        <button class="btn btn-secondary btn-export-sources" data-mod-sha1="${mod.sha1}">${iconSvg('archive')} export sources (.zip)</button>
      </div>
      <div class="decompiler-status">Click "explore classes" to browse .class files.</div>
      <div class="class-tree hidden">${renderClassTree(mod.classEntries, activeMinecraftVersion)}</div>
      <pre class="decompiler-output hidden"><code class="decompiler-code"></code></pre>
    </div>
  `;
}

function renderClassTree(classEntries, minecraftVersion) {
  const root = { dirs: {}, files: [] };
  const sorted = [...classEntries].sort((a, b) => a.entry.localeCompare(b.entry));

  for (const item of sorted) {
    const parts = item.entry.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.dirs[part]) {
        node.dirs[part] = { dirs: {}, files: [] };
      }
      node = node.dirs[part];
    }
    node.files.push(item);
  }

  const renderNode = node => {
    const dirNames = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
    const folders = dirNames.map(name => `
      <details class="class-tree-folder" open>
        <summary>${esc(name)}</summary>
        ${renderNode(node.dirs[name])}
      </details>
    `).join('');
    const files = node.files.map(file => `
      <button class="class-tree-file" type="button" data-class-name="${esc(file.name)}" data-class-entry="${esc(file.entry)}">${esc(file.entry.split('/').pop())}</button>
    `).join('');
    return `<div class="class-tree-children">${folders}${files}</div>`;
  };

  return `
    ${renderNode(root)}
    <div class="class-tree-minecraft">
      <div class="class-tree-minecraft-title">
        Minecraft sources (${esc(minecraftVersion || 'select version')})
      </div>
      <div class="class-tree-minecraft-list">
        <div class="class-tree-minecraft-empty">Click any net.minecraft symbol in the code to view its decompiled source here.</div>
      </div>
    </div>
  `;
}

function getClassCacheKey(modSha1, classEntry) {
  return `${classEntry}-${modSha1}:text`;
}

function readClassCache(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeClassCache(key, source) {
  try {
    localStorage.setItem(key, source);
  } catch (_) { /* ignore localStorage quota/privacy errors */ }
}

function detectMinecraftVersion(fmj) {
  const dep = fmj?.depends?.minecraft;
  if (!dep) return null;
  const parts = Array.isArray(dep) ? dep : [dep];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    if (part.trim() === '*') continue;
    const match = part.match(/\d+\.\d+(?:\.\d+)?/);
    if (match) return match[0];
  }
  return null;
}

function ensureModClassIndexes(mod) {
  if (mod.classBySlash && mod.classByDotted && mod.classBySimple) return;

  mod.classBySlash = new Map();
  mod.classByDotted = new Map();
  mod.classBySimple = new Map();

  for (const entry of mod.classEntries || []) {
    const slash = entry.name;
    const dotted = slash.replace(/\//g, '.');
    const simple = dotted.split('.').pop();
    mod.classBySlash.set(slash, entry);
    mod.classByDotted.set(dotted, entry);
    if (!mod.classBySimple.has(simple)) mod.classBySimple.set(simple, []);
    mod.classBySimple.get(simple).push(entry);
  }
}

function parseSourceContext(source) {
  const imports = new Map();
  let packageName = '';

  for (const line of source.split('\n')) {
    const pkg = line.match(/^\s*package\s+([\w.]+)\s*;/);
    if (pkg) packageName = pkg[1];
    const imp = line.match(/^\s*import\s+([\w.]+)\s*;/);
    if (imp) {
      const full = imp[1];
      imports.set(full.split('.').pop(), full);
    }
  }

  return { packageName, imports };
}

function resolveClassEntry(mod, classRef, sourceContext = null) {
  if (!mod) return null; // Minecraft source has no owning mod jar
  ensureModClassIndexes(mod);

  if (!classRef) return null;
  const normalized = classRef.replace(/\$/g, '$');
  if (mod.classByDotted.has(normalized)) return mod.classByDotted.get(normalized);
  const slashName = normalized.replace(/\./g, '/');
  if (mod.classBySlash.has(slashName)) return mod.classBySlash.get(slashName);

  if (!normalized.includes('.') && sourceContext) {
    const imported = sourceContext.imports.get(normalized);
    if (imported && mod.classByDotted.has(imported)) return mod.classByDotted.get(imported);
    if (sourceContext.packageName) {
      const inPackage = `${sourceContext.packageName}.${normalized}`;
      if (mod.classByDotted.has(inPackage)) return mod.classByDotted.get(inPackage);
    }
  }

  if (!normalized.includes('.')) {
    const matches = mod.classBySimple.get(normalized);
    if (matches && matches.length === 1) return matches[0];
  }

  return null;
}

function analyzeDeclarations(source) {
  const byLine = { classes: new Map(), methods: new Map() };
  const methodTargets = new Set();
  const methodPattern = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|\s)+[\w<>\[\],?.@ ]+\s+([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*(?:throws[^{]+)?\{/;
  const classPattern = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)\b/;
  const blockedMethods = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw']);

  source.split('\n').forEach((line, index) => {
    const classMatch = line.match(classPattern);
    if (classMatch) byLine.classes.set(index, classMatch[2]);

    const methodMatch = line.match(methodPattern);
    if (methodMatch && !blockedMethods.has(methodMatch[1])) {
      byLine.methods.set(index, methodMatch[1]);
      methodTargets.add(methodMatch[1]);
    }
  });

  return { byLine, methodTargets };
}

function escHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'record', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized',
  'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var'
]);

// History list of Minecraft classes opened in this panel. Each entry stores the
// canonical (intermediary) name so it can be reopened in any mapping namespace.
function addMinecraftTreeEntry(panel, canonicalInterm, displayName) {
  const list = $('.class-tree-minecraft-list', panel);
  if (!list) return;
  $('.class-tree-minecraft-empty', list)?.remove();

  const existing = $(`.minecraft-tree-link[data-canonical="${CSS.escape(canonicalInterm)}"]`, list);
  if (existing) {
    existing.textContent = displayName;
    $$('.minecraft-tree-link.active', list).forEach(el => el.classList.remove('active'));
    existing.classList.add('active');
    return;
  }

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'minecraft-tree-link active';
  link.dataset.canonical = canonicalInterm;
  link.textContent = displayName;
  $$('.minecraft-tree-link.active', list).forEach(el => el.classList.remove('active'));
  list.appendChild(link);
}

function updateMinecraftTreeVersion(panel) {
  const version = panel.dataset.mcVersion || '';
  const title = $('.class-tree-minecraft-title', panel);
  if (title) {
    title.textContent = `Minecraft sources (${version || 'select version'})`;
  }
}

function renderHighlightedSource(source, mod, className, panel) {
  const { byLine, methodTargets } = analyzeDeclarations(source);
  const sourceContext = parseSourceContext(source);
  panel._sourceContext = sourceContext;

  const lines = source.split('\n');
  let inBlockComment = false;

  const renderIdentifier = (token, lineIndex, nextChar, isDeclarationToken) => {
    if (JAVA_KEYWORDS.has(token)) {
      return `<span class="code-kw">${token}</span>`;
    }

    if (isDeclarationToken?.type === 'class') {
      return `<span id="class-target-${escHtml(token)}" class="code-class-target">${escHtml(token)}</span>`;
    }
    if (isDeclarationToken?.type === 'method') {
      return `<span id="method-target-${escHtml(token)}" class="code-method-target">${escHtml(token)}</span>`;
    }

    if (nextChar === '(' && methodTargets.has(token)) {
      return `<button class="code-link code-method-link" type="button" data-jump-type="method" data-jump-target="${escHtml(token)}">${escHtml(token)}</button>`;
    }

    const classEntry = resolveClassEntry(mod, token, sourceContext);
    if (classEntry) {
      return `<button class="code-link code-class-link" type="button" data-jump-type="class" data-class-name="${escHtml(classEntry.name)}">${escHtml(token)}</button>`;
    }

    if (token.startsWith('net.minecraft.')) {
      return `<button class="code-link code-minecraft-link" type="button" data-jump-type="minecraft" data-minecraft-class="${escHtml(token)}">${escHtml(token)}</button>`;
    }

    if (!token.includes('.') && sourceContext.imports.has(token)) {
      const imported = sourceContext.imports.get(token);
      if (imported.startsWith('net.minecraft.')) {
        return `<button class="code-link code-minecraft-link" type="button" data-jump-type="minecraft" data-minecraft-class="${escHtml(imported)}">${escHtml(token)}</button>`;
      }
    }

    if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) {
      const unresolved = resolveClassEntry(mod, token, sourceContext);
      if (unresolved) {
        return `<button class="code-link code-class-link" type="button" data-jump-type="class" data-class-name="${escHtml(unresolved.name)}">${escHtml(token)}</button>`;
      }
    }

    return escHtml(token);
  };

  const renderedLines = lines.map((line, lineIndex) => {
    const classDecl = byLine.classes.get(lineIndex);
    const methodDecl = byLine.methods.get(lineIndex);
    let i = 0;
    let out = '';

    while (i < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          out += `<span class="code-comment">${escHtml(line.slice(i))}</span>`;
          i = line.length;
          continue;
        }
        out += `<span class="code-comment">${escHtml(line.slice(i, end + 2))}</span>`;
        i = end + 2;
        inBlockComment = false;
        continue;
      }

      if (line.startsWith('//', i)) {
        out += `<span class="code-comment">${escHtml(line.slice(i))}</span>`;
        break;
      }

      if (line.startsWith('/*', i)) {
        const end = line.indexOf('*/', i + 2);
        if (end === -1) {
          out += `<span class="code-comment">${escHtml(line.slice(i))}</span>`;
          inBlockComment = true;
          break;
        }
        out += `<span class="code-comment">${escHtml(line.slice(i, end + 2))}</span>`;
        i = end + 2;
        continue;
      }

      const ch = line[i];
      if (ch === '"' || ch === '\'') {
        const quote = ch;
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === quote) {
            j += 1;
            break;
          }
          j += 1;
        }
        out += `<span class="code-string">${escHtml(line.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      if (/\d/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /[\d_\.xXa-fA-FLlFfDd]/.test(line[j])) j += 1;
        out += `<span class="code-number">${escHtml(line.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      if (ch === '@' && /[A-Za-z_$]/.test(line[i + 1] || '')) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_$.]/.test(line[j])) j += 1;
        out += `<span class="code-annotation">${escHtml(line.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_$\.]/.test(line[j])) j += 1;
        const token = line.slice(i, j);
        let k = j;
        while (k < line.length && /\s/.test(line[k])) k += 1;
        const nextChar = line[k] || '';
        let declarationToken = null;
        if (classDecl && token === classDecl) declarationToken = { type: 'class' };
        if (methodDecl && token === methodDecl) declarationToken = { type: 'method' };
        out += renderIdentifier(token, lineIndex, nextChar, declarationToken);
        i = j;
        continue;
      }

      out += escHtml(ch);
      i += 1;
    }

    return `<div class="code-line">${out || '&nbsp;'}</div>`;
  });

  panel.dataset.currentClass = className;
  return renderedLines.join('');
}

async function openClassInPanel(panel, mod, className, status) {
  const classEntry = resolveClassEntry(mod, className, panel._sourceContext);
  if (!classEntry) {
    status.textContent = `Class not found in this jar: ${className}`;
    return;
  }

  const classBtn = $(`.class-tree-file[data-class-name="${CSS.escape(classEntry.name)}"]`, panel);
  if (classBtn) {
    $$('.class-tree-file.active', panel).forEach(el => el.classList.remove('active'));
    classBtn.classList.add('active');
  }

  const output = $('.decompiler-output', panel);
  const code = $('.decompiler-code', panel);
  const cacheKey = getClassCacheKey(mod.sha1, classEntry.entry);
  const cached = readClassCache(cacheKey);

  panel.dataset.viewKind = 'mod';
  status.textContent = `Decompiling ${classEntry.name}...`;
  if (cached) {
    code.innerHTML = renderHighlightedSource(await applyModMappings(panel, cached), mod, classEntry.name, panel);
    output.classList.remove('hidden');
    status.textContent = `Loaded ${classEntry.name} from cache.`;
    return;
  }

  try {
    const source = await decompileClassInMod(mod, classEntry.name);
    writeClassCache(cacheKey, source);
    code.innerHTML = renderHighlightedSource(await applyModMappings(panel, source), mod, classEntry.name, panel);
    output.classList.remove('hidden');
    status.textContent = `Decompiled ${classEntry.name}.`;
  } catch (err) {
    status.textContent = `Decompilation failed: ${err.message}`;
  }
}

// Rewrites a mod's intermediary net.minecraft references to the namespace
// chosen in the mappings dropdown, so mod source matches the rest of the UI.
async function applyModMappings(panel, source) {
  const version = panel.dataset.mcVersion;
  const namespace = panel.dataset.mcNamespace;
  if (!version || !namespace || namespace === 'intermediary') return source;
  try {
    const mc = await getMcModule();
    return await mc.remapModSource(version, namespace, source);
  } catch (_) {
    return source;
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Decompile every top-level class in the mod jar, remap net.minecraft references
// to the selected mappings, and download the sources as a .zip.
async function exportAllSources(mod, panel, status, btn) {
  // Top-level classes only — Vineflower nests inner classes into their outer file.
  const entries = (mod.classEntries || []).filter(e => !e.name.split('/').pop().includes('$'));
  if (!entries.length) { status.textContent = 'No classes to export.'; return; }

  const version = panel.dataset.mcVersion;
  const namespace = panel.dataset.mcNamespace;
  const remap = namespace && namespace !== 'intermediary';
  const total = entries.length;

  btn.disabled = true;
  status.textContent = `Preparing to decompile ${total} classes…`;
  try {
    const decompile = await getVineflowerDecompiler();
    const mc = remap ? await getMcModule().catch(() => null) : null;
    if (!mod.classResources) mod.classResources = mod.classEntries.map(i => i.name);

    const zip = new JSZip();
    let done = 0, failed = 0;
    const BATCH = 100;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      status.textContent = `Decompiling ${Math.min(i + BATCH, total)}/${total}…`;
      // Yield so the status text repaints before the heavy synchronous decompile.
      await new Promise(r => setTimeout(r, 0));

      let result;
      try {
        result = await decompile(batch.map(e => e.name), {
          resources: mod.classResources,
          source: n => getClassBytes(mod, n),
          options: { banner: '// Decompiled with Tailor using Vineflower\n\n' },
        });
      } catch (_) {
        result = {};
      }

      for (const e of batch) {
        let src = result[e.name];
        if (!src) { failed++; continue; }
        if (mc) {
          try { src = await mc.remapModSource(version, namespace, src); } catch (_) { /* keep raw */ }
        }
        zip.file(`${e.name}.java`, src);
        done++;
      }
    }

    status.textContent = `Packaging ${done} files…`;
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => { status.textContent = `Packaging ${done} files… ${meta.percent.toFixed(0)}%`; }
    );
    const nsTag = remap ? `-${namespace}` : '';
    const base = String(mod.fmj?.id || mod.filename || 'sources').replace(/[^\w.-]+/g, '_');
    triggerDownload(blob, `${base}-sources${nsTag}.zip`);
    status.textContent = `Exported ${done} classes${failed ? ` (${failed} failed)` : ''} to ${base}-sources${nsTag}.zip.`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

function setupDecompilerButtons() {
  $$('.decompiler-panel').forEach(panel => {
    if (panel.dataset.bound) return;
    panel.dataset.bound = '1';

    const exploreBtn = $('.btn-explore-classes', panel);
    const tree = $('.class-tree', panel);
    const status = $('.decompiler-status', panel);
    const output = $('.decompiler-output', panel);
    const code = $('.decompiler-code', panel);
    const mcSelect = $('.decompiler-mc-select', panel);
    const mappingSelect = $('.decompiler-mapping-select', panel);
    const exportBtn = $('.btn-export-sources', panel);

    exploreBtn.addEventListener('click', () => {
      tree.classList.toggle('hidden');
    });

    exportBtn?.addEventListener('click', async () => {
      const mod = findModInStackBySha1(exportBtn.dataset.modSha1);
      if (mod) await exportAllSources(mod, panel, status, exportBtn);
    });

    mcSelect?.addEventListener('change', () => {
      panel.dataset.mcVersion = mcSelect.value;
      panel.dataset.mcNamespace = mcPickNamespace(mcSelect.value);
      if (mappingSelect) mappingSelect.value = panel.dataset.mcNamespace;
      updateMinecraftTreeVersion(panel);
    });

    mappingSelect?.addEventListener('change', async () => {
      panel.dataset.mcNamespace = mappingSelect.value;
      mcStoreNamespace(mappingSelect.value);
      // Re-render whatever is currently shown under the new mappings.
      if (panel.dataset.viewKind === 'mc' && panel.dataset.mcCanonical) {
        await loadMcClass(panel, panel.dataset.mcCanonical, status);
      } else if (panel.dataset.viewKind === 'mod' && panel.dataset.currentClass) {
        const mod = findModInStackBySha1(exploreBtn.dataset.modSha1);
        if (mod) await openClassInPanel(panel, mod, panel.dataset.currentClass, status);
      }
    });

    tree.addEventListener('click', async e => {
      // Reopen a previously visited Minecraft class.
      const mcEntry = e.target.closest('.minecraft-tree-link');
      if (mcEntry) {
        await loadMcClass(panel, mcEntry.dataset.canonical, status);
        return;
      }

      const classBtn = e.target.closest('.class-tree-file');
      if (!classBtn) return;

      const mod = findModInStackBySha1(exploreBtn.dataset.modSha1);
      if (!mod) return;

      $$('.class-tree-file.active', tree).forEach(el => el.classList.remove('active'));
      classBtn.classList.add('active');

      panel.dataset.viewKind = 'mod';
      const className = classBtn.dataset.className;
      classBtn.disabled = true;
      try {
        await openClassInPanel(panel, mod, className, status);
      } finally {
        classBtn.disabled = false;
      }
    });

    code.addEventListener('click', async e => {
      const target = e.target.closest('.code-link');
      if (!target) return;

      const jumpType = target.dataset.jumpType;
      if (jumpType === 'method') {
        const method = target.dataset.jumpTarget;
        const methodTarget = $(`#method-target-${CSS.escape(method)}`, code);
        methodTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      if (jumpType === 'minecraft') {
        // The clicked symbol may be in any namespace; loadMcClass resolves it.
        await loadMcClass(panel, target.dataset.minecraftClass, status);
        return;
      }

      if (jumpType === 'class') {
        // Class links only exist for mod source (Minecraft source has no mod).
        const mod = findModInStackBySha1(exploreBtn.dataset.modSha1);
        if (!mod) return;
        panel.dataset.viewKind = 'mod';
        await openClassInPanel(panel, mod, target.dataset.className, status);
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  Minecraft source viewing — version/namespace selection (DOM glue lives here;
//  the fetch/remap/decompile pipeline lives in the mc.js module).
// ══════════════════════════════════════════════════════════════════════════

const MC_MODULE_URL = './mc.js';
let mcModulePromise = null;
const getMcModule = () => (mcModulePromise ??= import(MC_MODULE_URL));

// ── Version comparison ──
function mcParseVersionParts(version) {
  // Returns numeric [major, minor, patch] for plain releases, or null for
  // snapshots / new date-based ids (treated as newest / deobfuscated).
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function compareMcVersions(a, b) {
  const pa = mcParseVersionParts(a);
  const pb = mcParseVersionParts(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;   // non-release id sorts newest
  if (!pb) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function mcVersionNeedsMappings(version) {
  // Releases up to and including 1.21.11 are obfuscated; anything newer
  // (or non-release ids like "26.2") ships deobfuscated.
  const parts = mcParseVersionParts(version);
  if (!parts) return false;
  return compareMcVersions(version, MC_LAST_OBFUSCATED_VERSION) <= 0;
}

function mcDefaultNamespace(version) {
  // Yarn for < 1.21.11, Mojang for >= 1.21.11 (per project decision).
  return compareMcVersions(version, MC_LAST_OBFUSCATED_VERSION) < 0 ? 'loom' : 'mojang';
}

function mcStoredNamespace() {
  try { return localStorage.getItem(MC_NS_STORAGE_KEY); } catch (_) { return null; }
}

function mcStoreNamespace(ns) {
  try { localStorage.setItem(MC_NS_STORAGE_KEY, ns); } catch (_) { /* ignore */ }
}

function mcPickNamespace(version) {
  const stored = mcStoredNamespace();
  if (stored && MC_NAMESPACES.includes(stored)) return stored;
  return mcDefaultNamespace(version);
}

// ── Environment → which jar to load ──
// Fabric mappings (Yarn/Intermediary) are built against the client obfuscation,
// and the client jar already bundles the integrated server — so it covers almost
// all net.minecraft classes. The server jar is obfuscated independently, so
// merging it would both corrupt the name lookup and double the download. Only a
// server-exclusive mod uses the server jar.
function mcEnvironmentFor(fmj) {
  return fmj?.environment === 'server' ? ['server'] : ['client'];
}

// ── Per-version Minecraft source loader (DOM glue around the mc.js module) ──
async function loadMcClass(panel, className, status) {
  const version = panel.dataset.mcVersion;
  if (!version) { status.textContent = 'No Minecraft version selected.'; return; }

  const environment = (panel.dataset.mcEnv || 'client,server').split(',').filter(Boolean);
  // Always honour the selected namespace; the module falls back to a raw
  // decompile when no mappings are published for the version (deobfuscated).
  const namespace = panel.dataset.mcNamespace || mcPickNamespace(version);

  const dotted = className.replace(/\//g, '.');
  status.textContent = `Loading Minecraft ${version} source for ${dotted}… (first load downloads the game jar)`;

  try {
    const mc = await getMcModule();
    const { source, targetName, canonicalInterm, namespace: usedNs } =
      await mc.decompileMinecraftClass({ version, namespace, environment, name: className });

    const output = $('.decompiler-output', panel);
    const code = $('.decompiler-code', panel);
    const display = targetName.replace(/\//g, '.');
    panel.dataset.viewKind = 'mc';
    panel.dataset.mcCanonical = canonicalInterm;
    code.innerHTML = renderHighlightedSource(source, null, display, panel);
    output.classList.remove('hidden');
    addMinecraftTreeEntry(panel, canonicalInterm, display);
    const nsLabel = usedNs ? MC_NAMESPACE_LABELS[usedNs] : 'no mappings';
    status.textContent = `Loaded Minecraft ${display} (${nsLabel}).`;
  } catch (err) {
    status.textContent = `Minecraft source failed: ${err.message}`;
    console.error(err);
  }
}

function formatVer(ver) {
  const str = typeof ver === 'string' ? ver : Array.isArray(ver) ? ver.join(' || ') : JSON.stringify(ver);
  return str;
}

function verIsSpecific(ver) {
  const str = typeof ver === 'string' ? ver : Array.isArray(ver) ? ver.join(' || ') : JSON.stringify(ver);
  return str !== '*';
}

function renderDepList(deps) {
  return `<div class="dep-list">${Object.entries(deps).map(([id, ver]) => `
    <div class="dep-item">
      <span class="dep-name">${esc(id)}</span>
      <span class="dep-version ${verIsSpecific(ver) ? 'ver-specific' : ''}">${esc(formatVer(ver))}</span>
    </div>
  `).join('')}</div>`;
}

function renderBreakList(breaks) {
  return `<div class="break-list">${Object.entries(breaks).map(([id, ver]) => `
    <div class="break-item" style="border-left:3px solid var(--red)">
      <span class="break-name">${esc(id)}</span>
      <span class="break-version ${verIsSpecific(ver) ? 'ver-specific' : ''}">${esc(formatVer(ver))}</span>
    </div>
  `).join('')}</div>`;
}

function renderEntrypoints(entrypoints) {
  return `<div class="entry-list">${Object.entries(entrypoints).flatMap(([type, entries]) =>
    (Array.isArray(entries) ? entries : [entries]).map(e => `
      <div class="entry-item">
        <span class="entry-name">${esc(typeof e === 'string' ? e : e.value || JSON.stringify(e))}</span>
        <span class="entry-type">${esc(type)}</span>
      </div>
    `)
  ).join('')}</div>`;
}

function renderMixins(mixins) {
  return `<div class="mixin-list">${mixins.map(m => `
    <div class="mixin-item">
      <span class="mixin-name">${esc(typeof m === 'string' ? m : m.config)}</span>
      ${typeof m === 'object' && m.environment ? `<span class="tag ${envClass(m.environment)}" style="font-size:0.72rem">${envLabel(m.environment)}</span>` : ''}
    </div>
  `).join('')}</div>`;
}

function renderContact(contact) {
  return `<div class="contact-links">${Object.entries(contact).map(([key, url]) => `
    <a class="contact-link" href="${esc(url)}" target="_blank" rel="noopener">${iconSvg('external')} ${esc(key)}</a>
  `).join('')}</div>`;
}

// ── Helpers ──
function detailCard(title, icon, content, extraClass = '', row = '') {
  return `<div class="detail-card collapsible expanded ${extraClass}" ${row ? `data-row="${row}"` : ''}>
    <h3 class="detail-card-header">${icon} <span class="detail-card-title">${title}</span> <svg class="detail-card-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></h3>
    <div class="detail-card-body">${content}</div>
  </div>`;
}

function isLibrary(fmj) {
  return fmj?.custom?.['fabric-loom:generated'] === true;
}

function envClass(env, fmj) {
  if (isLibrary(fmj)) return 'env-library';
  if (env === 'client') return 'env-client';
  if (env === 'server') return 'env-server';
  return 'env-both';
}

function envLabel(env, fmj) {
  if (isLibrary(fmj)) return 'Library';
  if (env === 'client') return 'Client';
  if (env === 'server') return 'Server';
  return 'Both sides';
}

function titleCase(s) {
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}

function esc(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatDownloads(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function showLoading(msg) {
  const el = $('#loading');
  el.classList.remove('hidden');
  el.querySelector('p').textContent = msg || 'Analyzing mod...';
}

function hideLoading() {
  $('#loading').classList.add('hidden');
}

function resetView() {
  if (modStack.length) {
    modStack.forEach(clearModResources);
  }
  $('#results-section').classList.add('hidden');
  $('#input-section').style.display = '';
  fileInput.value = '';
  modStack = [];
  modrinthLookup = {};
}

function iconSvg(name) {
  const icons = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22V8"/><path d="M20 4l-7.5 7.5"/><path d="M4 4l7.5 7.5"/><path d="M6 22h12"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    modrinth: '<svg viewBox="0 0 514 514" width="16" height="16" fill="currentColor"><path d="M504.16 323.56c11.39-42.09 12.16-87.65.04-132.8C467.57 54.23 327.04-26.8 190.33 9.78 84.81 38.02 12.39 128.07 1.69 230.47h43.3c10.3-83.14 69.75-155.74 155.76-178.76 106.3-28.45 215.38 28.96 253.42 129.67l-42.14 11.27c-19.39-46.85-58.46-81.2-104.73-95.83l-7.74 43.84c36.53 13.47 66.16 43.84 77 84.25 15.8 58.89-13.62 119.23-67 144.26l11.53 42.99c70.16-28.95 112.31-101.86 102.34-177.02l41.98-11.23a210.2 210.2 0 0 1-3.86 84.16z"/><path d="M322.99 504.22C186.27 540.8 45.75 459.77 9.11 323.24A257.6 257.6 0 0 1 1 275.46h43.27c1.09 11.91 3.2 23.89 6.41 35.83 3.36 12.51 7.77 24.46 13.11 35.78l38.59-23.15a169 169 0 0 1-8.17-23.45c-24.04-89.6 29.2-181.7 118.92-205.71 17-4.55 34.1-6.32 50.8-5.61L256.19 133c-10.46.05-21.08 1.42-31.66 4.25-66.22 17.73-105.52 85.7-87.78 151.84 1.1 4.07 2.38 8.04 3.84 11.9l49.35-29.61-14.87-39.43 46.6-47.87 58.9-12.69 17.05 20.99-27.15 27.5-23.68 7.45-16.92 17.39 8.29 23.07s16.79 17.84 16.82 17.85l23.72-6.31 16.88-18.54 36.86-11.67 10.98 24.7-38.03 46.63-63.73 20.18-28.58-31.82-49.82 29.89c25.54 29.08 63.94 45.23 103.75 41.86l11.53 42.99c-59.41 7.86-117.44-16.73-153.49-61.91l-38.41 23.04c50.61 66.49 138.2 99.43 223.97 76.48 61.74-16.52 109.79-58.6 135.81-111.78l42.64 15.5c-30.89 66.28-89.84 118.94-166.07 139.34"/></svg>',
    'arrow-left': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
    'file-code': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="10" y1="12" x2="8" y2="15"/><line x1="10" y1="18" x2="8" y2="15"/><line x1="14" y1="12" x2="16" y2="15"/><line x1="14" y1="18" x2="16" y2="15"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  };
  return icons[name] || '';
}

// Make functions available globally
window.resetView = resetView;
window.navigateBack = navigateBack;
