// The box you type a cell into, and the chrome around it.
//
// One Monaco editor per cell, built when the row appears and thrown away when it goes. This
// used to be a single editor moved into whichever cell had focus, with the others showing a
// <pre> coloured by monaco.editor.colorize - cheaper, and wrong twice over:
//
//   - focusing a cell replaced the very element the click had landed on, so the click did not
//     reach the editor and it took several to get in;
//   - and leaving a cell rebuilt its box from `cell.source`, which turned every bug anywhere
//     near that value into the cell's text visibly vanishing.
//
// A row that scrolls out of the expression list is unmounted by Desmos, so the number of live
// editors is bounded by what is on screen rather than by how many cells the graph has. The text
// is never re-derived from anything: the Monaco model *is* the text, it outlives the row, and
// nothing repaints on focus.
//
// Until Monaco arrives - or for good, if it never does - a cell is a textarea. That is worth
// keeping for the reason extensions/settings/tabs/themes.js keeps it: a cell you cannot edit is
// a cell you cannot empty, and nothing here should need a CDN to be fixable. Running does not
// depend on Monaco at all; only the colours and the error markers do.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    // The same pinned copy extensions/settings/tabs/themes.js loads, for the same reasons:
    // 0.52.2 is the last release shipping the AMD build, and it is cross-origin on purpose -
    // the proxy rewrites any same-origin URL onto its own prefix, so a copy served from this
    // site could not fetch its own modules.
    var MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";

    /** Kept in step with index.css. */
    var FONT = 13;
    var LINE = 20;
    var PAD = 12;

    /** Past this the box scrolls rather than growing without end. */
    var MAX_HEIGHT = 480;

    var api = null;
    var loading = null;

    /** expr-id -> the editor in that row, while the row exists. */
    var editors = new Map();

    /** expr-id -> Monaco model. Outlives the row, so scrolling costs no undo history. */
    var models = new Map();

    /** A cell to focus as soon as its row turns up - the freshly created one. */
    var pending = null;

    var Calc = null;
    var ui = null;

    lua.editor = {
        init: init,
        attach: attach,
        detach: detach,
        refresh: refresh,
        render: render,
        forget: forget,
        focusSoon: function (id) {
            pending = id;
        }
    };

    function init(calc) {
        Calc = calc;
        ui = window.__desmosExt.ui;
    }

    // -----------------------------------------------------------------------
    // a cell's row
    // -----------------------------------------------------------------------

    /**
     * Give `cell` its box inside `node`, its row. Called again on a row it already owns - the
     * virtualizer rebuilds rows as it scrolls, and React drops anything we put on them - so
     * everything here is written to be idempotent.
     */
    function attach(cell, node) {
        if (cell.node === node && node.contains(cell.host)) {
            take(cell);
            return;
        }

        node.setAttribute("data-cde-lua", "");

        var anchor = node.querySelector(".dcg-displayTextarea");
        var parent = anchor ? anchor.parentNode : node;

        cell.node = node;
        cell.host = build(cell);
        inset(cell.host, anchor);
        if (anchor && anchor.nextSibling)
            parent.insertBefore(cell.host, anchor.nextSibling);
        else parent.appendChild(cell.host);

        mount(cell);
        render(cell);
        take(cell);
    }

    /**
     * Stand where the note's own text stands.
     *
     * Desmos insets everything in a note - `.dcg-fixed-width-element` is
     * `padding: 15px 35px 9px 53px` - and that 53px on the left is what clears the row's icon
     * gutter. A box inserted beside it without the same inset starts underneath the gutter,
     * where its left edge is cut off and cannot be clicked. Taken from the sibling rather than
     * hard-coded, so the folder variant and any future change come along for free.
     */
    function inset(host, anchor) {
        if (!anchor || !window.getComputedStyle) return;
        var style = window.getComputedStyle(anchor);
        if (style.paddingLeft) host.style.paddingLeft = style.paddingLeft;
        if (style.paddingRight) host.style.paddingRight = style.paddingRight;
    }

    /** The row has gone - scrolled away, not deleted. Keep the model; drop the editor. */
    function detach(cell) {
        var editor = editors.get(cell.id);
        if (editor) {
            // The model is not disposed with it: the model is the text, and the text stays.
            editor.dispose();
            editors.delete(cell.id);
        }
        if (cell.host && cell.host.parentNode)
            cell.host.parentNode.removeChild(cell.host);
        if (cell.node) cell.node.removeAttribute("data-cde-lua");
        cell.host = null;
        cell.node = null;
        cell.box = null;
    }

    /** The cell is gone for good. */
    function forget(cell) {
        detach(cell);
        var model = models.get(cell.id);
        if (!model) return;
        // A moment's grace, so delete-then-undo keeps its history.
        setTimeout(function () {
            if (lua.cell(cell.id)) return;
            model.dispose();
            models.delete(cell.id);
        }, 5000);
    }

    function build(cell) {
        var host = ui.el("div", { class: "cde-lua" });

        var run = ui.el("button", {
            class: "cde-lua__run",
            type: "button",
            onclick: function (event) {
                event.preventDefault();
                event.stopPropagation();
                lua.runner.toggle(cell);
            }
        });
        var status = ui.el("span", { class: "cde-lua__status" });

        var box = ui.el("div", { class: "cde-lua__box" });
        var out = ui.el("pre", { class: "cde-lua__out" });
        var error = ui.el("div", { class: "cde-lua__error" });

        // Desmos tracks what the pointer is over by writing dcg-hovered onto every element
        // under it. Monaco decides what was clicked by comparing a line's className against
        // "view-line" exactly, so a line wearing a class of Desmos' is a line it does not
        // recognise - clicking the text does nothing. Keeping the mouse inside the box keeps
        // the classes off it. extensions/settings/tabs/themes.js:218-231 is the same fix.
        ["mousedown", "mousemove", "mouseup"].forEach(function (type) {
            box.addEventListener(type, function (event) {
                event.stopPropagation();
            });
        });

        // Desmos binds arrows, Enter and Backspace to moving around the expression list. The
        // editor needs all of them to mean what they mean in an editor.
        ["keydown", "keypress", "keyup"].forEach(function (type) {
            host.addEventListener(type, function (event) {
                event.stopPropagation();
                if (type === "keydown" && event.key === "Escape") blur(cell);
            });
        });

        ui.el(
            host,
            null,
            ui.el("div", { class: "cde-lua__bar" }, run, status),
            box,
            out,
            error
        );

        cell.box = box;
        cell.parts = { run: run, status: status, out: out, error: error };
        return host;
    }

    // -----------------------------------------------------------------------
    // the editor in it
    // -----------------------------------------------------------------------

    /** Put an editor in the cell's box - Monaco if we have it, a textarea until we do. */
    function mount(cell) {
        if (!cell.box) return;

        if (!api) {
            plain(cell);
            want();
            return;
        }
        if (editors.has(cell.id)) return;

        cell.box.textContent = "";
        var editor = api.editor.create(cell.box, {
            model: model(cell),
            theme: "vs-dark",
            // One editor per row and a width we do not set, so Monaco can watch its own
            // container. Height is ours, and wordWrap is off, so this cannot feed back.
            automaticLayout: true,
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            // The completion list is taller than a row has room for; a fixed widget is
            // positioned against the viewport instead of being clipped by the cell.
            fixedOverflowWidgets: true,
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            folding: false,
            wordWrap: "off",
            fontSize: FONT,
            lineHeight: LINE,
            padding: { top: 6, bottom: 6 }
        });
        editors.set(cell.id, editor);

        editor.onDidContentSizeChange(function () {
            size(cell);
        });
        editor.onDidBlurEditorText(function () {
            lua.flush(cell.id);
            if (cell.on) lua.runner.run(cell);
        });
        editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.Enter, function () {
            lua.flush(cell.id);
            lua.runner.run(cell);
        });

        size(cell);
        markers(cell, cell.syntax || cell.error || "");
    }

    /** The box grows with the text, up to a point, after which it scrolls. */
    function size(cell) {
        var editor = editors.get(cell.id);
        if (!editor || !cell.box) return;
        var h = Math.min(
            MAX_HEIGHT,
            Math.max(LINE, editor.getContentHeight()) + PAD
        );
        cell.box.style.height = h + "px";
    }

    /** The textarea: the way in before Monaco arrives, and the way in if it never does. */
    function plain(cell) {
        var existing = cell.box.querySelector(".cde-lua__plain");
        if (existing) {
            if (existing.value !== cell.source) existing.value = cell.source;
            return;
        }

        var input = ui.el("textarea", {
            class: "cde-lua__plain",
            spellcheck: "false",
            autocapitalize: "off",
            autocomplete: "off",
            wrap: "off",
            "aria-label": "Lua",
            oninput: function () {
                lua.edited(cell.id, input.value);
                input.style.height = tall(input.value) + "px";
            },
            onblur: function () {
                lua.flush(cell.id);
                if (cell.on) lua.runner.run(cell);
            }
        });
        input.value = cell.source;
        input.style.height = tall(cell.source) + "px";
        cell.box.textContent = "";
        cell.box.appendChild(input);
    }

    function tall(text) {
        var lines = String(text || "").split("\n").length;
        return Math.min(MAX_HEIGHT, Math.max(LINE, lines * LINE) + PAD);
    }

    /** The model is the text. It outlives the row, which is why scrolling costs nothing. */
    function model(cell) {
        var found = models.get(cell.id);
        if (found) return found;

        found = api.editor.createModel(cell.source, "lua");
        found.updateOptions({
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false
        });
        found.onDidChangeContent(function () {
            lua.edited(cell.id, found.getValue());
        });
        models.set(cell.id, found);
        return found;
    }

    /**
     * The text changed underneath the box - an undo, a graph load, another tab. Catch the box
     * up. Nothing else redraws on its own: the editor and the model are the same text.
     */
    function refresh(cell) {
        var found = models.get(cell.id);
        if (found && found.getValue() !== cell.source)
            // Through an edit rather than setValue, so the editor's own undo history is not
            // thrown away while someone is typing in it.
            found.pushEditOperations(
                null,
                [{ range: found.getFullModelRange(), text: cell.source }],
                null
            );
        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (input && input.value !== cell.source) input.value = cell.source;
    }

    /** Focus a cell that asked to be focused as soon as it had somewhere to be. */
    function take(cell) {
        if (pending !== cell.id) return;
        pending = null;
        var editor = editors.get(cell.id);
        if (editor) return editor.focus();
        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (input) input.focus();
    }

    /** Escape: hand the keyboard back to Desmos. */
    function blur(cell) {
        var editor = editors.get(cell.id);
        if (editor) {
            var node = editor.getDomNode();
            if (node) node.blur();
            var area = cell.box && cell.box.querySelector("textarea");
            if (area) area.blur();
            return;
        }
        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (input) input.blur();
    }

    // -----------------------------------------------------------------------
    // the chrome
    // -----------------------------------------------------------------------

    function render(cell) {
        if (!cell.parts) return;
        var p = cell.parts;

        p.run.textContent = cell.on ? "■" : "▶";
        p.run.title = cell.on ? "Stop this cell" : "Run this cell";
        p.run.classList.toggle("cde-lua__run--on", !!cell.on);

        // Nothing for "off": the button already says so, and a cell that has never run has
        // nothing to report.
        var note = "";
        if (cell.syntax) note = "syntax error";
        else if (cell.co && cell.parked) note = "waiting for the graph";
        else if (cell.co) note = "running";
        else if (cell.on && cell.exports.size)
            note = cell.exports.size + " exported";
        p.status.textContent = note;

        p.out.textContent = (cell.output || []).join("\n");
        p.out.classList.toggle("cde-lua--shown", !!(cell.output || []).length);

        var problem = cell.syntax || cell.error || "";
        p.error.textContent = problem;
        p.error.classList.toggle("cde-lua--shown", !!problem);

        markers(cell, problem);
    }

    /** A squiggle under the line the error names, when there is an editor to put one in. */
    function markers(cell, problem) {
        if (!api) return;
        var found = models.get(cell.id);
        if (!found) return;
        if (!problem) return api.editor.setModelMarkers(found, "cde-lua", []);

        var line = lua.runner.line(cell, problem);
        if (!line) return api.editor.setModelMarkers(found, "cde-lua", []);
        api.editor.setModelMarkers(found, "cde-lua", [
            {
                severity: api.MarkerSeverity.Error,
                message: problem,
                startLineNumber: line,
                endLineNumber: line,
                startColumn: 1,
                endColumn: found.getLineMaxColumn(line)
            }
        ]);
    }

    // -----------------------------------------------------------------------
    // Monaco
    // -----------------------------------------------------------------------

    /** Ask for Monaco, once, the first time a cell is drawn. */
    function want() {
        if (loading) return loading;
        loading = load().then(
            function (monaco) {
                api = monaco;
                ready();
            },
            function (error) {
                console.warn(
                    "desmos: Monaco didn't load, so Lua cells are plain textareas",
                    error
                );
            }
        );
        return loading;
    }

    function load() {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = MONACO + "/vs/loader.js";
            script.onerror = function () {
                reject(new Error("couldn't fetch " + script.src));
            };
            script.onload = function () {
                // loader.js puts its AMD require on the window over anything of that name.
                // The Desmos bundle ran long ago, so there is nothing left to confuse.
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
            document.head.appendChild(script);
        });
    }

    var worker = null;

    /**
     * A worker cannot be made from another origin, so this is the way round it that Monaco
     * documents: a worker of ours, one line long, that pulls the real one in.
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

    /** Monaco has arrived: give every cell already on screen a real editor. */
    function ready() {
        complete();
        lua.cells.forEach(function (cell) {
            if (cell.box) mount(cell);
        });
    }

    /** What the graph and the bridge can offer the completion list. */
    function complete() {
        var BUILTIN = [
            [
                "Desmos.get",
                'Desmos.get("\\\\sin(2)")',
                "The value of any latex, blocking until it has one."
            ],
            [
                "Desmos.define",
                'Desmos.define("g(x)", "x^{2}+1")',
                "Write an expression's latex yourself."
            ],
            [
                "Desmos.sample",
                'Desmos.sample("g", f, 0, 10, 200)',
                "Plot a Lua function as sampled points."
            ]
        ];

        api.languages.registerCompletionItemProvider("lua", {
            provideCompletionItems: function (model, position) {
                var word = model.getWordUntilPosition(position);
                var range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn
                };

                var items = BUILTIN.map(function (entry) {
                    return {
                        label: entry[0],
                        kind: api.languages.CompletionItemKind.Function,
                        detail: entry[1],
                        documentation: entry[2],
                        insertText: entry[0],
                        range: range
                    };
                });

                lua.bridge.names().forEach(function (name) {
                    items.push({
                        label: name,
                        kind: api.languages.CompletionItemKind.Variable,
                        detail: "on the graph",
                        insertText: name,
                        range: range
                    });
                });

                return { suggestions: items };
            }
        });
    }
})();
