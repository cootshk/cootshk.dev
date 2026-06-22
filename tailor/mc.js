/* ──────────────────────────────────────────────────────────────────────────
 * Tailor — Minecraft source pipeline (browser- and Deno-agnostic).
 *
 * Fetches Minecraft jars from Mojang, remaps the obfuscated bytecode with the
 * chosen mappings (Yarn/Loom, Mojang, or Intermediary) using @run-slicer/asm,
 * and decompiles a requested class with Vineflower. The DOM-facing glue lives
 * in app.js; everything here is pure and unit-testable.
 * ────────────────────────────────────────────────────────────────────────── */

// Distinct query string from app.js's vf import so the Minecraft decompiler gets
// its OWN Vineflower (WASM) module instance — a shared instance can carry state
// corruption across the mod decompiler and this one.
let VF_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@run-slicer/vf@0.6.3-1.12.0/vf.js?tailor-mc';
const ASM_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@run-slicer/asm@0.17.0/+esm';
const ZIP_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@run-slicer/zip@0.5.2/+esm';

// Test hook: point the Vineflower module elsewhere (e.g. a local file:// build
// to exercise the WASM path under Deno). No effect once vf has been loaded.
export function _setVfUrl(url) { VF_MODULE_URL = url; }

export const MC_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const YARN_MAVEN_BASE = 'https://maven.fabricmc.net/net/fabricmc/yarn';
const DECOMPILE_BANNER = '// Decompiled with Tailor using Vineflower\n\n';

let vfPromise = null, asmPromise = null, zipPromise = null;
const getVf = () => (vfPromise ??= import(VF_MODULE_URL).then(m => m.decompile));
const getAsm = () => (asmPromise ??= import(ASM_MODULE_URL));
const getZip = () => (zipPromise ??= import(ZIP_MODULE_URL));

const mcState = {
  manifest: null,
  metaCache: new Map(),
  yarnBuild: new Map(),
  jarCache: new Map(),
  tableCache: new Map(),
};

// ── Fetch helpers (manifest/meta small; jars/mappings via Cache Storage) ──
export async function getVersionManifest() {
  if (mcState.manifest) return mcState.manifest;
  const res = await fetch(MC_VERSION_MANIFEST_URL);
  if (!res.ok) throw new Error(`Version manifest HTTP ${res.status}`);
  mcState.manifest = await res.json();
  return mcState.manifest;
}

async function getVersionMeta(version) {
  if (mcState.metaCache.has(version)) return mcState.metaCache.get(version);
  const manifest = await getVersionManifest();
  const entry = manifest.versions.find(v => v.id === version);
  if (!entry) throw new Error(`Minecraft version ${version} not found in manifest`);
  const meta = await cachedFetchJson(entry.url);
  mcState.metaCache.set(version, meta);
  return meta;
}

async function openMcCache() {
  try { return typeof caches !== 'undefined' ? await caches.open('tailor-mc') : null; }
  catch (_) { return null; }
}

async function cachedFetchBlob(url) {
  const cache = await openMcCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return await hit.blob();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (cache) {
    try { await cache.put(url, res.clone()); } catch (_) { /* quota */ }
  }
  return await res.blob();
}

const cachedFetchText = async (url) => (await cachedFetchBlob(url)).text();
const cachedFetchJson = async (url) => JSON.parse(await cachedFetchText(url));

async function resolveYarnBuild(version) {
  if (mcState.yarnBuild.has(version)) return mcState.yarnBuild.get(version);
  const xml = await cachedFetchText(`${YARN_MAVEN_BASE}/maven-metadata.xml`);
  const re = new RegExp(`<version>(${version.replace(/[.]/g, '\\.')}\\+build\\.(\\d+))</version>`, 'g');
  let best = null, bestNum = -1, m;
  while ((m = re.exec(xml))) {
    const num = Number(m[2]);
    if (num > bestNum) { bestNum = num; best = m[1]; }
  }
  mcState.yarnBuild.set(version, best);
  return best;
}

// ── Jar access (lazy per-entry inflation via @run-slicer/zip) ──
async function openMcJar(version, environment) {
  const key = `${version}:${environment.join('+')}`;
  if (mcState.jarCache.has(key)) return mcState.jarCache.get(key);

  const promise = (async () => {
    const zip = await getZip();
    const meta = await getVersionMeta(version);
    const entryByClass = new Map();

    for (const which of environment) {
      const dl = meta.downloads?.[which];
      if (!dl) continue;
      const blob = await cachedFetchBlob(dl.url);
      const archive = await zip.readBlob(blob);
      for (const e of archive.entries) {
        if (e.isDirectory || !e.name.endsWith('.class')) continue;
        const name = e.name.slice(0, -6);
        if (!entryByClass.has(name)) entryByClass.set(name, e);
      }
    }

    return {
      has: (name) => entryByClass.has(name),
      classNames: () => entryByClass.keys(),
      bytes: async (name) => {
        const e = entryByClass.get(name);
        return e ? await e.bytes() : null;
      },
    };
  })();

  mcState.jarCache.set(key, promise);
  return promise;
}

// ── Descriptor / signature remapping ──
function makeClassMapper(classObf2Target) {
  const mapPlain = (name) => {
    const direct = classObf2Target.get(name);
    if (direct) return direct;
    const dollar = name.lastIndexOf('$');
    if (dollar > 0) return mapPlain(name.slice(0, dollar)) + '$' + name.slice(dollar + 1);
    return name;
  };
  return mapPlain;
}

const mapDescriptor = (desc, mapPlain) => desc.replace(/L([^;]+);/g, (_, n) => 'L' + mapPlain(n) + ';');
const remapSignature = (sig, mapPlain) => sig.replace(/L([A-Za-z0-9_$/]+)/g, (_, n) => 'L' + mapPlain(n));
const mapClassEntryName = (name, mapPlain) =>
  name.charCodeAt(0) === 91 /* '[' */ ? mapDescriptor(name, mapPlain) : mapPlain(name);

// ── ProGuard (Mojang) mappings ──
function proguardSourceTypeToJvm(type, official2obf) {
  let dims = 0;
  while (type.endsWith('[]')) { dims++; type = type.slice(0, -2); }
  const prim = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' }[type];
  let base;
  if (prim) {
    base = prim;
  } else {
    const official = type.replace(/\./g, '/');
    base = 'L' + (official2obf.get(official) || official) + ';';
  }
  return '['.repeat(dims) + base;
}

export function parseProguard(text) {
  const classObf2Official = new Map();
  const official2obf = new Map();
  const rawClasses = [];
  let current = null;

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (line.charCodeAt(0) !== 32 && line.charCodeAt(0) !== 9) {
      const m = /^(.+?) -> (.+?):$/.exec(line);
      if (!m) { current = null; continue; }
      const official = m[1].replace(/\./g, '/');
      const obf = m[2].replace(/\./g, '/');
      classObf2Official.set(obf, official);
      official2obf.set(official, obf);
      current = { obfOwner: obf, members: [] };
      rawClasses.push(current);
    } else if (current) {
      current.members.push(line.trim());
    }
  }

  const methodMap = new Map();
  const fieldMap = new Map();

  for (const cls of rawClasses) {
    for (const raw of cls.members) {
      const m = /^(?:\d+:\d+:)?(.+?) (\S+?)\((.*?)\)(?::\d+(?::\d+)?)? -> (\S+)$/.exec(raw);
      if (m) {
        const ret = proguardSourceTypeToJvm(m[1], official2obf);
        const args = m[3].trim()
          ? m[3].split(',').map(a => proguardSourceTypeToJvm(a.trim(), official2obf)).join('')
          : '';
        methodMap.set(`${cls.obfOwner}\0${m[4]}\0(${args})${ret}`, m[2]);
        continue;
      }
      const f = /^(.+?) (\S+?) -> (\S+)$/.exec(raw);
      if (f) fieldMap.set(`${cls.obfOwner}\0${f[3]}`, f[2]);
    }
  }

  return { classObf2Official, official2obf, methodMap, fieldMap };
}

// ── Tiny v2 (Yarn merged: official / intermediary / named) ──
export function parseTinyV2(text) {
  const lines = text.split('\n');
  const header = lines[0].split('\t'); // tiny 2 0 official intermediary named
  const nsIndex = {};
  for (let i = 3; i < header.length; i++) nsIndex[header[i]] = i - 3;
  const iInterm = nsIndex.intermediary ?? 1;
  const iNamed = nsIndex.named ?? 2;

  const records = [];
  const methods = [];
  const fields = [];
  let curObf = null;

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const p = line.split('\t');
    if (p[0] === 'c') {
      curObf = p[1];
      records.push({ obf: p[1], interm: p[1 + iInterm] || p[1], named: p[1 + iNamed] || '' });
    } else if (p[0] === '' && (p[1] === 'm' || p[1] === 'f')) {
      const desc = p[2];
      const obf = p[3];
      const interm = p[3 + iInterm] || obf;
      const named = p[3 + iNamed] || '';
      if (p[1] === 'm') methods.push({ owner: curObf, desc, obf, interm, named });
      else fields.push({ owner: curObf, obf, interm, named });
    }
  }

  return { records, methods, fields };
}

// ── Unified mapping table for a (version, namespace) ──
async function buildMappingTable(version, namespace) {
  const key = `${version}:${namespace}`;
  if (mcState.tableCache.has(key)) return mcState.tableCache.get(key);

  const promise = (async () => {
    // Yarn merged gives official↔intermediary (navigation) plus named + interm.
    const yarnBuild = await resolveYarnBuild(version);
    let tiny = null;
    if (yarnBuild) {
      const zip = await getZip();
      const jarBlob = await cachedFetchBlob(`${YARN_MAVEN_BASE}/${yarnBuild}/yarn-${yarnBuild}-mergedv2.jar`);
      const archive = await zip.readBlob(jarBlob);
      const entry = archive.entries.find(e => e.name === 'mappings/mappings.tiny');
      if (entry) tiny = parseTinyV2(await entry.text());
    }

    const classObf2Target = new Map();
    const methodMap = new Map();
    const fieldMap = new Map();
    const obf2interm = new Map();
    const interm2obf = new Map();
    const target2interm = new Map();
    // Maps keyed by intermediary name, for remapping a mod's own decompiled
    // source (whose net.minecraft references are always intermediary).
    const classFullToTarget = new Map();   // 'net/minecraft/class_310' -> target slash path
    const classSimpleToTarget = new Map(); // 'class_310' -> target simple name
    const memberToTarget = new Map();      // 'method_1551' / 'field_x' -> target name

    if (tiny) {
      for (const r of tiny.records) {
        if (r.interm) { obf2interm.set(r.obf, r.interm); interm2obf.set(r.interm, r.obf); }
      }
    }

    const addClassSrc = (interm, target) => {
      if (!interm || !target || interm === target) return;
      classFullToTarget.set(interm, target);
      classSimpleToTarget.set(interm.split('/').pop(), target.split('/').pop());
    };

    if (namespace === 'mojang') {
      const meta = await getVersionMeta(version);
      const url = meta.downloads?.client_mappings?.url || meta.downloads?.server_mappings?.url;
      if (!url) throw new Error(`No Mojang mappings published for ${version}`);
      const pg = parseProguard(await cachedFetchText(url));
      for (const [obf, official] of pg.classObf2Official) {
        classObf2Target.set(obf, official);
        target2interm.set(official, obf2interm.get(obf) || obf);
      }
      for (const [k, v] of pg.methodMap) methodMap.set(k, v);
      for (const [k, v] of pg.fieldMap) fieldMap.set(k, v);
      // intermediary -> official for source-text remapping
      for (const [interm, obf] of interm2obf) addClassSrc(interm, classObf2Target.get(obf));
      if (tiny) {
        for (const m of tiny.methods) {
          const off = pg.methodMap.get(`${m.owner}\0${m.obf}\0${m.desc}`);
          if (off && m.interm) memberToTarget.set(m.interm, off);
        }
        for (const f of tiny.fields) {
          const off = pg.fieldMap.get(`${f.owner}\0${f.obf}`);
          if (off && f.interm) memberToTarget.set(f.interm, off);
        }
      }
    } else if (tiny) {
      const pick = (interm, named) => (namespace === 'loom' ? (named || interm) : interm);
      for (const r of tiny.records) {
        const target = pick(r.interm, r.named) || r.obf;
        classObf2Target.set(r.obf, target);
        target2interm.set(target, r.interm || r.obf);
        addClassSrc(r.interm, target);
      }
      for (const m of tiny.methods) {
        const target = pick(m.interm, m.named);
        if (target) methodMap.set(`${m.owner}\0${m.obf}\0${m.desc}`, target);
        if (m.interm && m.named && m.named !== m.interm) memberToTarget.set(m.interm, m.named);
      }
      for (const f of tiny.fields) {
        const target = pick(f.interm, f.named);
        if (target) fieldMap.set(`${f.owner}\0${f.obf}`, target);
        if (f.interm && f.named && f.named !== f.interm) memberToTarget.set(f.interm, f.named);
      }
    } else {
      throw new Error(`No mappings available for Minecraft ${version}`);
    }

    const mapClass = makeClassMapper(classObf2Target);
    const reverseTargetClass = new Map();

    return {
      namespace, classObf2Target, methodMap, fieldMap,
      obf2interm, interm2obf, target2interm, reverseTargetClass,
      classFullToTarget, classSimpleToTarget, memberToTarget,
      mapClass,
      mapDesc: (d) => mapDescriptor(d, mapClass),
      mapSig: (s) => remapSignature(s, mapClass),
      toObf(name) { return reverseTargetClass.get(name) || interm2obf.get(name) || null; },
      toInterm(name) {
        if (interm2obf.has(name)) return name;
        const obf = reverseTargetClass.get(name);
        if (obf) return obf2interm.get(obf) || obf;
        return name;
      },
    };
  })();

  mcState.tableCache.set(key, promise);
  return promise;
}

// ── Bytecode remapper built on @run-slicer/asm ──
const ASM_UTF8 = 1, ASM_CLASS = 7, ASM_FIELDREF = 9, ASM_METHODREF = 10,
  ASM_IFACE_METHODREF = 11, ASM_NAME_AND_TYPE = 12, ASM_METHOD_TYPE = 16,
  ASM_DYNAMIC = 17, ASM_INVOKE_DYNAMIC = 18;
const EMPTY_BYTES = new Uint8Array(0);

async function createRemapper(table, jar) {
  const asm = await getAsm();
  const hierCache = new Map();
  const memberCache = new Map();

  async function hierarchyOf(obfName) {
    if (hierCache.has(obfName)) return hierCache.get(obfName);
    const info = { superName: null, interfaces: [] };
    try {
      const bytes = await jar.bytes(obfName);
      if (bytes) {
        const node = asm.read(bytes, asm.FLAG_SKIP_ATTR);
        if (node.superClass) info.superName = node.pool[node.superClass.name].string;
        info.interfaces = node.interfaces.map(i => node.pool[i.name].string);
      }
    } catch (_) { /* keep empty */ }
    hierCache.set(obfName, info);
    return info;
  }

  async function resolveMember(owner, name, desc, isMethod) {
    const cacheKey = `${owner}\0${name}\0${desc}\0${isMethod ? 'm' : 'f'}`;
    if (memberCache.has(cacheKey)) return memberCache.get(cacheKey);
    const map = isMethod ? table.methodMap : table.fieldMap;
    const seen = new Set();
    const stack = [owner];
    let result = null;
    while (stack.length) {
      const cls = stack.pop();
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      const k = isMethod ? `${cls}\0${name}\0${desc}` : `${cls}\0${name}`;
      if (map.has(k)) { result = map.get(k); break; }
      const h = await hierarchyOf(cls);
      if (h.superName) stack.push(h.superName);
      for (const i of h.interfaces) stack.push(i);
    }
    memberCache.set(cacheKey, result);
    return result;
  }

  async function remapClass(bytes) {
    const node = asm.read(bytes);
    const pool = node.pool;
    const entries = pool.slice(0); // intern() appends to pool; iterate a snapshot

    const utf8Map = new Map();
    for (const e of entries) {
      if (e && e.type === ASM_UTF8 && !utf8Map.has(e.string)) utf8Map.set(e.string, e);
    }
    const intern = (str) => {
      let e = utf8Map.get(str);
      if (e) return e;
      e = { type: ASM_UTF8, index: pool.length, string: str, bytes: EMPTY_BYTES, dirty: true };
      pool.push(e);
      utf8Map.set(str, e);
      return e;
    };
    const ntMap = new Map();
    const internNameType = (name, desc) => {
      const nameIdx = intern(name).index;
      const typeIdx = intern(desc).index;
      const key = `${nameIdx}\0${typeIdx}`;
      let e = ntMap.get(key);
      if (e) return e;
      e = { type: ASM_NAME_AND_TYPE, index: pool.length, name: nameIdx, type_: typeIdx };
      pool.push(e);
      ntMap.set(key, e);
      return e;
    };

    const classObf = new Map();
    for (const e of entries) {
      if (e && e.type === ASM_CLASS) classObf.set(e, pool[e.name].string);
    }
    const thisObf = classObf.get(node.thisClass);

    // 1. Field/method/dynamic references and method types.
    const refs = [];
    for (const e of entries) {
      if (!e) continue;
      if (e.type === ASM_FIELDREF || e.type === ASM_METHODREF || e.type === ASM_IFACE_METHODREF) {
        refs.push(e);
      } else if (e.type === ASM_DYNAMIC || e.type === ASM_INVOKE_DYNAMIC) {
        const nt = pool[e.nameType];
        e.nameType = internNameType(pool[nt.name].string, table.mapDesc(pool[nt.type_].string)).index;
      } else if (e.type === ASM_METHOD_TYPE) {
        e.descriptor = intern(table.mapDesc(pool[e.descriptor].string)).index;
      }
    }
    for (const e of refs) {
      const ownerObf = classObf.get(pool[e.ref]);
      const nt = pool[e.nameType];
      const name = pool[nt.name].string;
      const desc = pool[nt.type_].string;
      const isMethod = e.type !== ASM_FIELDREF;
      let targetName = name;
      if (ownerObf != null && name !== '<init>' && name !== '<clinit>') {
        const resolved = await resolveMember(ownerObf, name, desc, isMethod);
        if (resolved) targetName = resolved;
      }
      e.nameType = internNameType(targetName, table.mapDesc(desc)).index;
    }

    // 2. Class names (after ref owners were snapshotted).
    for (const e of entries) {
      if (e && e.type === ASM_CLASS) {
        e.name = intern(mapClassEntryName(classObf.get(e), table.mapClass)).index;
      }
    }

    // 3. Declared members (walk hierarchy so overrides pick up inherited names).
    for (const m of node.fields) {
      const t = thisObf != null ? await resolveMember(thisObf, m.name.string, m.type.string, false) : null;
      m.name = intern(t || m.name.string);
      m.type = intern(table.mapDesc(m.type.string));
    }
    for (const m of node.methods) {
      const mn = m.name.string;
      let t = null;
      if (thisObf != null && mn !== '<init>' && mn !== '<clinit>') {
        t = await resolveMember(thisObf, mn, m.type.string, true);
      }
      m.name = intern(t || mn);
      m.type = intern(table.mapDesc(m.type.string));
    }

    // 4. Signature + InnerClasses attributes (class- and member-level).
    const remapAttrs = (attrs) => {
      for (const a of attrs) {
        if (a.type === 'Signature' && a.signatureEntry) {
          a.signatureEntry = intern(table.mapSig(a.signatureEntry.string));
          a.dirty = true;
        } else if (a.type === 'InnerClasses' && a.classes) {
          for (const ic of a.classes) {
            if (ic.innerNameEntry && ic.innerEntry) {
              const full = pool[ic.innerEntry.name].string;
              ic.innerNameEntry = intern(full.split('/').pop().split('$').pop());
            }
          }
          a.dirty = true;
        }
      }
    };
    remapAttrs(node.attrs);
    for (const m of node.fields) remapAttrs(m.attrs);
    for (const m of node.methods) remapAttrs(m.attrs);

    return asm.write(node);
  }

  return { remapClass };
}

// ── Decompiled-source cache (per session in memory, persisted in localStorage) ──
const SOURCE_CACHE_PREFIX = 'tailor-mc-src2:'; // bump to discard stale/poisoned entries
const sourceMem = new Map();

// Vineflower emits this banner instead of code when it cannot decompile a class.
// Such output must never be cached, or one transient failure becomes permanent.
function isDecompileFailure(src) {
  return !src || src.includes("$VF: Couldn't be decompiled") || src.includes('// $VF:');
}

function readSourceCache(key) {
  if (sourceMem.has(key)) return sourceMem.get(key);
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(key);
      if (v != null) { sourceMem.set(key, v); return v; }
    }
  } catch (_) { /* ignore */ }
  return null;
}

function writeSourceCache(key, value) {
  sourceMem.set(key, value);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  catch (_) { /* quota / privacy mode — memory cache still applies */ }
}

function ensureResources(table, jar) {
  if (table._resources) return;
  const list = [];
  for (const obf of jar.classNames()) {
    const t = table.mapClass(obf);
    table.reverseTargetClass.set(t, obf);
    list.push(t);
  }
  table._resources = list;
}

// Rewrites the intermediary net.minecraft references in a mod's own decompiled
// source to the selected namespace, so the displayed names match the dropdown.
// No-op for the intermediary namespace (or when no mappings are available).
export async function remapModSource(version, namespace, source) {
  if (!namespace || namespace === 'intermediary') return source;
  let table;
  try { table = await buildMappingTable(version, namespace); }
  catch (_) { return source; }
  const { classFullToTarget, classSimpleToTarget, memberToTarget } = table;
  if (!classFullToTarget?.size && !memberToTarget?.size) return source;

  // 1. Fully-qualified class refs (imports + inline), incl. inner classes.
  let out = source.replace(/net\.minecraft\.(class_\d+(?:\$class_\d+)*)/g, (m, cls) => {
    const t = classFullToTarget.get('net/minecraft/' + cls);
    return t ? t.replace(/\//g, '.') : m;
  });
  // 2. Bare intermediary tokens used via imports (class_/method_/field_).
  out = out.replace(/\b(class_\d+|method_\d+|field_\d+)\b/g, (tok) =>
    (tok.charCodeAt(0) === 99 ? classSimpleToTarget.get(tok) : memberToTarget.get(tok)) || tok);
  return out;
}

// ── Public entry point ──
// Decompiles a single Minecraft class. `name` may be given in any namespace (it
// is resolved through the mapping table). Returns { source, targetName,
// canonicalInterm, namespace } where canonicalInterm is the stable intermediary
// name and `namespace` is the namespace actually applied (null if the build was
// already deobfuscated / no mappings were available). Results are cached.
export async function decompileMinecraftClass({ version, namespace, environment, name }) {
  const decompile = await getVf();
  const jar = await openMcJar(version, environment);
  const slash = name.replace(/\./g, '/');

  // Mapping path — applied whenever a namespace is requested and mappings exist.
  if (namespace) {
    let table = null;
    try { table = await buildMappingTable(version, namespace); }
    catch (_) { table = null; } // no mappings published for this version
    if (table) {
      ensureResources(table, jar);
      const obf = table.toObf(slash);
      if (obf) {
        const canonicalInterm = table.obf2interm.get(obf) || slash;
        const targetName = table.mapClass(obf);
        const cacheKey = `${SOURCE_CACHE_PREFIX}${version}:${namespace}:${targetName}`;
        const cached = readSourceCache(cacheKey);
        if (cached != null) return { source: cached, targetName, canonicalInterm, namespace };

        const remapper = await createRemapper(table, jar);
        const sourceFn = async (n) => {
          const o = table.reverseTargetClass.get(n);
          if (!o) return null;
          const b = await jar.bytes(o);
          if (!b) return null;
          try { return await remapper.remapClass(b); } catch (_) { return null; }
        };
        const result = await decompile([targetName], {
          resources: table._resources, source: sourceFn, options: { banner: DECOMPILE_BANNER },
        });
        const source = result[targetName];
        if (!source) throw new Error(`Decompiler returned no source for ${targetName.replace(/\//g, '.')}`);
        if (!isDecompileFailure(source)) writeSourceCache(cacheKey, source);
        return { source, targetName, canonicalInterm, namespace };
      }
      // Not resolvable via these mappings — fall through to a raw decompile.
    }
  }

  // Raw path — deobfuscated build, or no mappings available.
  if (!jar.has(slash)) throw new Error(`Class not found in Minecraft ${version}: ${name}`);
  const cacheKey = `${SOURCE_CACHE_PREFIX}${version}::${slash}`;
  const cached = readSourceCache(cacheKey);
  if (cached != null) return { source: cached, targetName: slash, canonicalInterm: slash, namespace: null };
  const result = await decompile([slash], {
    resources: [...jar.classNames()], source: (n) => jar.bytes(n), options: { banner: DECOMPILE_BANNER },
  });
  const source = result[slash];
  if (!source) throw new Error(`Decompiler returned no source for ${name}`);
  if (!isDecompileFailure(source)) writeSourceCache(cacheKey, source);
  return { source, targetName: slash, canonicalInterm: slash, namespace: null };
}
