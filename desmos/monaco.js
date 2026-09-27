// Monaco - the editor out of VS Code - fetched once for whoever wants one.
//
// Two extensions put a Monaco box on the page: extensions/lua, for a cell's code, and the
// Themes tab of extensions/settings, for a theme's CSS. They used to fetch a copy each, and
// that is not a cache hit: loader.js brings its own module registry, so a second one loads and
// re-runs editor.main.js over the top of the first and the second box waits as long as the
// first did. One copy here, one promise, and whichever box is drawn second is drawn at once.
//
// It is window.__desmosExt.monaco, and every hook that runs after the swap can reach it:
//
//   monaco.load() -> Promise    the api, loading it if this is the first ask. Rejects if the
//                               CDN cannot be reached, which is a case every caller has to
//                               have an answer for: a box that needs a CDN to work is a box
//                               that cannot be used to undo whatever broke the page.
//   monaco.api()                the api if it is already here, and null until it is. A box
//                               that asks this first can be built as Monaco straight away,
//                               rather than built as a textarea and replaced a second later.
//   monaco.warm() -> Promise    the same load, started next time the page is idle rather than
//                               now. For a moment that is probably about to want an editor -
//                               the graphs modal opening, an extension that draws cells
//                               starting up - so that the wait is over before anyone is
//                               looking at a box. Idle because nothing is waiting on it yet,
//                               and the page it shares a connection with is still loading.
//
// Loaded by index.html, ahead of desmos.js. It registers itself rather than being called by
// the loader, the way ui.js is: there is nothing to tell it. Nothing is fetched until the
// first load() or warm(), so a page that never opens an editor never pays for one.
(function () {
    // Pinned to 0.52.2, the last release to ship the AMD build this uses - 0.53 replaced it
    // with hashed ESM chunks. The same CDN copy Vencord's CSS editor loads.
    //
    // Cross-origin on purpose. The proxy rewrites any same-origin URL onto its own prefix
    // (worker.js), so a copy of Monaco served from this site could not fetch its own modules;
    // a host it has never heard of is passed through untouched, which is also how
    // extensions/desmosMd gets highlight.js.
    var MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";

    var ext = (window.__desmosExt = window.__desmosExt || {});

    // The load, once started. Kept whichever way it went: a failed load is not retried, so a
    // box asking after a CDN that is not there is told so immediately rather than waiting out
    // another timeout of its own.
    var loading = null;

    // The api, once it has arrived. The synchronous half of load(), and the whole reason this
    // is worth sharing.
    var api = null;

    // A warm load, from the idle callback that will start it. The same api at the end of it.
    var warming = null;

    function load() {
        if (loading) return loading;
        loading = fetchMonaco().then(function (monaco) {
            api = monaco;
            return monaco;
        });
        return loading;
    }

    function warm() {
        // Already going, idly or otherwise. load() is memoized, so a box that wants an editor
        // before the page goes idle starts this very load itself and the callback below finds
        // the work already begun.
        if (loading) return loading;
        if (warming) return warming;

        warming = new Promise(function (resolve) {
            var start = function () {
                resolve(load());
            };
            if (window.requestIdleCallback)
                window.requestIdleCallback(start, { timeout: 2000 });
            else window.setTimeout(start, 200);
        });
        // A caller that is only warming is not waiting on the answer, so an unreachable CDN
        // is not an unhandled rejection here. Whoever actually wants an editor reports it.
        warming.catch(function () {});
        return warming;
    }

    function fetchMonaco() {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = MONACO + "/vs/loader.js";
            script.onerror = function () {
                reject(new Error("couldn't fetch " + script.src));
            };
            script.onload = function () {
                // loader.js puts its AMD require on the window over anything of that name
                // that was there. By now the Desmos bundle has long since run, so there is
                // nothing left to confuse.
                var amd = window.require;
                amd.config({ paths: { vs: MONACO + "/vs" } });
                window.MonacoEnvironment = { getWorkerUrl: workerUrl };
                amd(
                    ["vs/editor/editor.main"],
                    function () {
                        resolve(window.monaco);
                    },
                    reject
                );
            };
            (document.head || document.documentElement).appendChild(script);
        });
    }

    var worker = null;

    /**
     * Where the language services - the completion, and the squiggles under a typo - run.
     * A worker cannot be made from another origin, so this is the way round that Monaco
     * documents: a worker of our own, one line long, that pulls the real one in. The proxy
     * prepends its bootstrap to a blob worker and patches importScripts inside it, which
     * changes nothing here: the URL below is on a host it does not proxy.
     */
    function workerUrl() {
        if (!worker) {
            var body =
                "self.MonacoEnvironment=" +
                JSON.stringify({ baseUrl: MONACO + "/" }) +
                ";\nimportScripts(" +
                JSON.stringify(MONACO + "/vs/base/worker/workerMain.js") +
                ");\n";
            worker = URL.createObjectURL(
                new Blob([body], { type: "text/javascript" })
            );
        }
        return worker;
    }

    ext.monaco = {
        load: load,
        warm: warm,
        api: function () {
            return api;
        }
    };
})();
