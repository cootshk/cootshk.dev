// Boots the proxied Desmos app (see worker.js) in this document, with extensions.
//
// The page is not simply navigated to on the proxy: extensions have to run before any of
// Desmos' own bundles do, and an ordinary page load offers no point at which to get in
// first. So the page is fetched here, its build script is held back, what is left replaces
// this document, the extensions run, and only then does Desmos start.
//
// The replacement is document.open()/write() rather than adopting the parsed tree, because
// written scripts are parser-inserted and so run in document order. Adopted nodes would be
// dynamically inserted, and that order is not guaranteed.
//
// Desmos and the loader share one window, which is the point - see extensions.js for the
// hooks an extension can implement, and ui.js for what they draw with.
const local = {
    fetch: window.fetch.bind(window),

    // Both HTMLScriptElement.prototype.src and Element.prototype.setAttribute are patched, so
    // this is the only way left to point a <script> or <link> at one of our own files:
    //   local.setAttribute.call(script, "src", url)
    setAttribute: Element.prototype.setAttribute
};

const PROXY = "/_/desmos";

// ?type=... -> where the app lives upstream. `key` is the name extensions.json uses, and
// `product` the name Desmos itself calls the calculator by - the four that share a bundle
// hand it around as `product`, and extensions/core turns it back into one of these.
const MODES = {
    graphing: {
        key: "graphing",
        path: "calculator",
        title: "Graphing Calculator",
        product: "graphing"
    },
    "3d": {
        key: "3d",
        path: "3d",
        title: "3D Calculator",
        product: "graphing-3d"
    },
    geometry: {
        key: "geometry",
        path: "geometry",
        title: "Geometry",
        product: "geometry-calculator"
    },
    notebook: {
        key: "notebook",
        path: "notebook",
        title: "Notebook",
        product: "notebook"
    },
    matrix: { key: "matrix", path: "matrix", title: "Matrix Calculator" },
    scientific: {
        key: "scientific",
        path: "scientific",
        title: "Scientific Calculator"
    },
    fourfunction: {
        key: "fourfunction",
        path: "fourfunction",
        title: "Four Function Calculator"
    }
};

const ALIASES = {
    calculator: "graphing",
    calc: "graphing",
    graph: "graphing",
    three: "3d",
    3: "3d",
    geo: "geometry",
    note: "notebook",
    matrices: "matrix",
    sci: "scientific",
    four: "fourfunction",
    fourfn: "fourfunction",
    4: "fourfunction"
};

const DEFAULT_MODE = "graphing";

// <script src="*/assets/build/*.js"> - Desmos' own bundle.
const BUILD_SCRIPT = /\/assets\/build\/[^?#]*\.js(?:[?#]|$)/i;

// A type the browser will not execute. The tag stays in the document because DesModder
// finds the bundle by querying for it, and polls forever if it is not there.
const HELD_TYPE = "text/x-desmos-held";

// How long to give an extension that owns the bundle before starting Desmos ourselves.
const BUNDLE_TIMEOUT = 10000;

/** Any of a mode's names - a ?type= value, an alias, or its upstream path - as a MODES key. */
function canonicalMode(name) {
    const raw = String(name ?? "")
        .trim()
        .toLowerCase();
    const key = ALIASES[raw] || raw;
    if (MODES[key]) return key;
    return Object.keys(MODES).find((k) => MODES[k].path === raw) || null;
}

/** The mode named by ?type=, falling back to the graphing calculator. */
function currentMode() {
    return MODES[
        canonicalMode(new URLSearchParams(location.search).get("type")) ||
            DEFAULT_MODE
    ];
}

/** The mode Desmos' own name for a calculator - "graphing-3d" - belongs to, or null. */
function modeForProduct(product) {
    return Object.values(MODES).find((one) => one.product === product) || null;
}

/** A graph ID out of a #fragment. */
function fragment(hash) {
    const raw = String(hash ?? "").replace(/^#\/?/, "");
    try {
        return decodeURIComponent(raw).trim();
    } catch (_) {
        return raw.trim(); // stray % - take it literally rather than throwing the load away
    }
}

/**
 * The #fragment, which is the graph ID (`#abcdef1234`), if there is one. Desmos reads the ID
 * out of location.pathname upstream; extensions/core patches it to read this instead, which
 * is what lets the address bar stay on /desmos.
 */
function currentGraph() {
    return fragment(location.hash);
}

function sourceUrl(mode, graph) {
    const path = graph
        ? PROXY + "/" + mode.path + "/" + encodeURIComponent(graph)
        : PROXY + "/" + mode.path;
    return new URL(path, location.origin).toString();
}

/**
 * This page's own address for a calculator and a graph: the calculator in ?type= and the
 * graph in the fragment, with whatever else was in the query (?ext=, say) left alone.
 *
 * The order matters - a query string written after the fragment is part of the fragment, and
 * comes back on the next load as a graph ID with a ?type= stuck to the end of it. This is the
 * one place any of these URLs are built, and extensions/core hands it to Desmos as getURL().
 */
function pageUrl(mode, graph) {
    const query = new URLSearchParams(location.search);
    query.set("type", mode.key);
    return (
        location.origin +
        location.pathname +
        "?" +
        query +
        (graph ? "#" + encodeURIComponent(graph) : "")
    );
}

/**
 * Where a link points, as a mode and a graph of ours - or null if it is not one of the
 * calculators. Both this page's own address and an upstream path are understood, with or
 * without the /_/desmos the proxy bootstrap puts back on every root-relative href.
 */
function linkTarget(href) {
    let url;
    try {
        url = new URL(href, document.baseURI);
    } catch (_) {
        return null;
    }
    if (url.origin !== location.origin) return null;

    const trim = (path) => path.replace(/\/+$/, "");
    let path = trim(url.pathname);
    if (path === PROXY || path.startsWith(PROXY + "/"))
        path = path.slice(PROXY.length);

    // This page. Desmos is handed these by getURL(), and the proxy's href rewriting has
    // usually put its own prefix back on the front by the time they reach the document.
    if (path === trim(location.pathname)) {
        const key =
            canonicalMode(new URLSearchParams(url.search).get("type")) ||
            DEFAULT_MODE;
        return { mode: MODES[key], graph: fragment(url.hash) };
    }

    // ...or an upstream one: /calculator, /3d/abcdef1234, and so on.
    const [, first, second] = path.split("/");
    const key = canonicalMode(first);
    if (!key) return null;
    return { mode: MODES[key], graph: second ? fragment(second) : "" };
}

/**
 * Open a calculator. Always a real load: Desmos' timers, workers, blob URLs and globals live
 * in this window, and swapping its API out in place - which is what its own buttons do - would
 * leave the page running the extensions and bundle patches of the calculator it started as.
 */
function navigateTo(mode, graph) {
    const url = pageUrl(mode, graph);
    const page = (href) => href.split("#")[0];
    // Assigning an address that differs from this one only after the "#" - or not at all -
    // would leave the document where it is. Put it in the bar by hand and load it.
    if (page(url) === page(location.href)) {
        if (url !== location.href) history.replaceState(null, "", url);
        location.reload();
        return;
    }
    location.assign(url);
}

// Object URLs belonging to the current load, handed out through ctx.blob() and released
// when the next load starts (the document may still be reading them until then).
let blobs = [];

function makeBlob(text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    blobs.push(url);
    return url;
}

function releaseBlobs() {
    for (const url of blobs) URL.revokeObjectURL(url);
    blobs = [];
}

// ---------------------------------------------------------------------------
// window patches
// ---------------------------------------------------------------------------

/**
 * Everything Desmos needs bent into shape, installed once the document has been replaced and
 * before the bundle runs. `bundle` is the patched copy of it, if an extension rewrote it.
 */
function patchWindow(bundle, buildPath) {
    const ext = (window.__desmosExt = window.__desmosExt || {});

    // Our own escape hatch from the proxy's rewriting, for hooks that run after the swap.
    ext.fetch = local.fetch;

    // The proxy bootstrap wraps history on the instance so that every URL Desmos builds out of
    // location keeps the prefix. In this document location is already ours, so that would turn
    // /desmos into /_/desmos/desmos. History.prototype still holds the unwrapped methods.
    for (const name of ["pushState", "replaceState"]) {
        const original = History.prototype[name];
        history[name] = function (state, title, url) {
            const result =
                arguments.length < 3 || url === null || url === undefined
                    ? original.call(history, state, title)
                    : original.call(history, state, title, url);
            // Saving or opening a graph writes the ID into the hash (extensions/core patches
            // getURL to build it that way). Keep up, so the hashchange handler below does not read
            // it back as a graph it has to go and load.
            graph = currentGraph();
            return result;
        };
    }

    // Extensions that rewrite the bundle hand us a blob of the patched source. DesModder
    // re-fetches the bundle by URL, so point that fetch at the patched copy instead. Matching
    // on the path alone: it appends a "?" to the URL to dodge its own blocking rules.
    if (bundle && buildPath) {
        const fetched = window.fetch;
        window.fetch = function (input, init) {
            try {
                const url = String(
                    input && input.url !== undefined ? input.url : input
                );
                if (new URL(url, document.baseURI).pathname === buildPath) {
                    return fetched.call(this, bundle, init);
                }
            } catch (_) {}
            return fetched.call(this, input, init);
        };
    }

    let calc;
    let hooks = [];

    function run(fn, data) {
        try {
            fn(calc, data);
        } catch (error) {
            console.error("desmos: extension ready hook failed", error);
        }
    }

    // window.Calc is a plain assignment inside the bundle, so a setter beats polling for it.
    Object.defineProperty(window, "Calc", {
        configurable: true,
        enumerable: true,
        get: () => calc,
        set: (value) => {
            calc = value;
            const pending = hooks;
            hooks = null;
            // The assignment happens in the middle of Desmos' own startup, so get out of its stack
            // before running anything: a slow hook here stalls initialization.
            if (pending)
                pending.forEach((hook) =>
                    queueMicrotask(() => run(hook.fn, hook.data))
                );
        }
    });

    ext.onCalc = (fn, data) => {
        if (hooks) hooks.push({ fn, data });
        else run(fn, data);
    };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/** Resolves once `doc` has finished parsing (and so has run its inline/blocking scripts). */
function parsed(doc) {
    if (doc.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) =>
        doc.addEventListener("DOMContentLoaded", resolve, { once: true })
    );
}

/** Replace this document with `html`, resolving once the new one has been parsed. */
async function swap(html) {
    // document.open() erases every event listener on the window and on every node in the
    // document, so nothing registered before this point survives it.
    document.open();
    document.write(html);
    document.close();
    listen();
    await parsed(document);
}

/** Run one hook. An extension that throws is dropped for the rest of this load. */
async function guard(entry, fn) {
    if (entry.failed) return undefined;
    try {
        return await fn();
    } catch (error) {
        entry.failed = true;
        console.error(`desmos: extension "${entry.def.id}" failed`, error);
        return undefined;
    }
}

/** Apply the source hooks to Desmos' bundle; null when nothing wanted to patch it. */
async function patchBundle(buildUrl, active, context) {
    const patchers = active.filter((entry) => entry.def.source);
    if (!buildUrl || !patchers.length) return null;

    const res = await fetch(buildUrl);
    if (!res.ok)
        throw new Error(`${buildUrl} -> ${res.status} ${res.statusText}`);

    // Desmos builds its worker from a string inside this file, so one text pass covers both.
    let text = await res.text();
    for (const entry of patchers) {
        const next = await guard(entry, () =>
            entry.def.source(text, context(entry))
        );
        if (typeof next === "string") text = next;
    }
    return makeBlob(text, "text/javascript");
}

/** Start Desmos: `src` is our patched blob, or the original URL when nothing patched it. */
function runBundle(src, original) {
    const script = document.createElement("script");
    if (original) {
        for (const { name, value } of original.attributes) {
            if (name === "src" || name === "type") continue;
            script.setAttribute(name, value);
        }
    }
    script.async = false; // dynamically inserted scripts would otherwise run out of order
    // Either a blob: URL or a path already under /_/ , both of which the proxy's patched src
    // setter leaves alone.
    script.src = src;
    (document.head || document.documentElement).appendChild(script);
}

// Which load is current: a hook that outlives its own load must not act on the next one.
let loads = 0;

/**
 * An extension that owns the bundle can still fail after we have handed off - a throw inside
 * DesModder's own preload is not catchable from here. Rather than leave the user with a blank
 * page, start Desmos ourselves if nothing else has.
 */
function watchdog(src, original, id, generation) {
    setTimeout(() => {
        if (generation !== loads) return; // superseded
        if (window.Calc !== undefined) return;
        console.warn(
            `desmos: "${id}" never started Desmos; starting it directly`
        );
        runBundle(src, original);
    }, BUNDLE_TIMEOUT);
}

async function load(mode, graph) {
    const generation = ++loads;
    releaseBlobs();

    const url = sourceUrl(mode, graph);
    const active = await enabledExtensions(mode);
    const context = (entry) => ({
        mode,
        graph,
        url,
        arg: entry.arg,
        blob: makeBlob,
        fetch: local.fetch
    });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    const source = new DOMParser().parseFromString(
        await res.text(),
        "text/html"
    );

    // Hold Desmos' bundle back without taking the tag out of the document.
    const build = [...source.querySelectorAll("script[src]")].filter((s) =>
        BUILD_SCRIPT.test(s.getAttribute("src"))
    );
    for (const script of build) script.setAttribute("type", HELD_TYPE);

    // This document's own URL is /desmos, so relative URLs (and the proxy bootstrap, which
    // resolves against document.baseURI) need the one it was fetched from spelled out.
    const base = source.createElement("base");
    base.setAttribute("href", url);
    source.head.prepend(base);

    for (const entry of active) {
        if (entry.def.html)
            await guard(entry, () => entry.def.html(source, context(entry)));
    }

    const buildUrl = build.length
        ? new URL(build[0].getAttribute("src"), url).toString()
        : null;
    const bundle = await patchBundle(buildUrl, active, context);

    // setup() may go to the network; let them all run at once.
    await Promise.all(
        active.map((entry) =>
            entry.def.setup
                ? guard(entry, async () => {
                      entry.data = await entry.def.setup(context(entry));
                  })
                : null
        )
    );

    await swap("<!DOCTYPE html>" + source.documentElement.outerHTML);
    title(mode);

    patchWindow(bundle, buildUrl ? new URL(buildUrl).pathname : null);
    // Before any extension runs: ui() and main() are where an extension draws, and both of
    // them reach for __desmosExt.ui.
    uiRuntime(uiConfig(mode, active));

    for (const entry of active) {
        // One guard() each, so an extension that throws does not stop the next one.
        await guard(entry, () => {
            const id = entry.def.id;
            // First, so that whatever the hooks below draw is styled the moment it appears.
            if (entry.css) __desmosExt.ui.css(id, entry.css);
            if (entry.def.ui)
                __desmosExt.ui.panel(id, entry.def.ui, entry.data);
            if (entry.def.main) entry.def.main(entry.data);
            if (entry.def.ready)
                __desmosExt.onCalc(entry.def.ready, entry.data);
        });
    }

    const src = bundle || (build.length ? build[0].getAttribute("src") : null);
    if (!src) {
        console.warn(
            `desmos: no build script in ${url}; the page shape must have changed`
        );
        return;
    }

    const owner = active.find((entry) => !entry.failed && entry.def.ownsBundle);
    if (owner) watchdog(src, build[0], owner.def.id, generation);
    else runBundle(src, build[0]);
}

function fail(error) {
    console.error("desmos: failed to load", error);
    document.open();
    document.write(
        '<!DOCTYPE html><meta charset="utf-8"><body style="font:16px/1.5 system-ui;padding:2rem">' +
            "<h1>Couldn't load Desmos</h1><pre></pre>"
    );
    document.close();
    listen();
    const pre = document.querySelector("pre");
    if (pre) pre.textContent = String(error);
}

// ---------------------------------------------------------------------------
// this page
// ---------------------------------------------------------------------------

const mode = currentMode();
let graph = currentGraph();

/** Ours rather than Desmos' - which takes the title back over as soon as it has a graph. */
function title(of) {
    document.title = `Desmos | ${of.title} (modded)`;
}

// Editing the fragment by hand (or following a link to another graph) swaps the graph out.
function onHashChange() {
    const next = currentGraph();
    if (next === graph) return;
    // Desmos' timers, workers, blob URLs and globals live in this window, and once it has
    // started there is no way to be rid of them: a real navigation is the only clean slate.
    // The hash survives it, so the graph below is the one that comes back up.
    if (window.Calc !== undefined) {
        location.reload();
        return;
    }
    graph = next;
    load(mode, graph).catch(fail);
}

/**
 * Desmos links to its other calculators by upstream path - /scientific, /3d/abcdef1234 - and
 * the proxy turns those into /_/desmos/..., which is the calculator with none of this on it.
 * Those are also the addresses it hands its own graph tiles. Send them through the loader.
 */
function onClick(event) {
    // Desmos' `ignoreRealClick` binds to the link itself, so a click it means to handle as a
    // tap of its own has already been prevented by the time it reaches the document. Modified
    // clicks belong to the browser - a new tab, a download - and are left alone.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

    const target = event.target;
    const link = target && target.closest && target.closest("a[href]");
    if (!link || link.hasAttribute("download")) return;
    if (link.target && link.target !== "_self") return;

    const to = linkTarget(link.href);
    if (!to) return;
    event.preventDefault();
    navigateTo(to.mode, to.graph);
}

/** Re-registered after every document.open(), which erases the lot. */
function listen() {
    // Named handlers, so that registering them twice is the no-op it looks like.
    addEventListener("hashchange", onHashChange);
    // On the document rather than the window: Desmos' own listeners are below this one, and
    // must get their say about a link before we decide nobody wanted it.
    document.addEventListener("click", onClick);
}

title(mode);
listen();

// Nothing can be drawn or loaded until the manifest says what exists. A manifest that will
// not read is not worth losing the calculator over: log it and carry on with no extensions.
loadManifest()
    .catch((error) =>
        console.error("desmos: could not read the extension manifest", error)
    )
    .then(() => {
        return load(mode, graph);
    })
    .catch(fail);
