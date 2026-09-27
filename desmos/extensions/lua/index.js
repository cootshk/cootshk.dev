// Lua cells in the expression sheet.
//
// Type `lua` into an empty expression and the row becomes a Lua editor. The cell can read the
// graph's values as ordinary globals - a Desmos `a=5` is `a` in Lua - and hand values back by
// assigning to `Desmos`, which writes real expressions into a hidden folder.
//
// This file owns the boring half: what a cell *is*, where its text lives, and when that text
// is written back to the graph. The other three are bridge.js (the Lua side of the bridge),
// runner.js (when a cell runs and what happens when it goes wrong) and editor.js (the box you
// type into). They hang themselves off `Extensions.lua`, which is why this file is first in
// the manifest's `file` list.
//
// A cell is its own item type - `{ type: "lua", id, text }` - and `text` is the Lua source,
// verbatim. Not a note with a marker in it, which is what this used to be.
//
// Desmos knows five item types and asks about them in eight places, three of which throw on a
// type they have not met. The patches below answer all eight, and every one of them answers by
// pointing at what Desmos already does for a note: the same state-to-model conversion, the same
// saved shape, the same row component. A Lua cell is a note in every respect except its name
// and what this extension does with it, which is why the whole thing costs eight one-line
// patches instead of an item model written from scratch.
//
// `text` rather than a field of its own for the same reason. A note's saved state is built by
// one function from a fixed list of fields, and its undo diffing from another; putting the
// source anywhere but `text` means patching both, for nothing but a nicer field name.
//
// The source is the chunk. Nothing is stripped from it, so Lua's line 3 is the editor's line 3.
// A first line of `--!lua <pragmas>` is read for pragmas and then left exactly where it is -
// it is a Lua comment, so the compiler does not care, and nothing has to count lines.
//
// The cost of a real type, stated plainly: with this extension switched off, Desmos does not
// know what a `lua` item is. `Hv`'s default hands the raw state object to the list in place of
// a model, and the incremental `setState` path throws outright. A graph with cells in it wants
// this extension. That is the trade a real item type makes, and the note form did not.
(function () {
    /**
     * A cell's optional first line: `--!lua <pragmas>`. Read for the pragmas and then left
     * alone - it is a Lua comment, so the compiler ignores it, and leaving it in means the
     * source is the chunk and no line numbers have to be adjusted.
     */
    var PRAGMA = /^--!lua[ \t]*([^\n]*)/;

    /**
     * The word that turns an expression into a cell, as it looks by the time it reaches the
     * state. Desmos has no magic words of its own - `table` is not one either - so this is
     * ours, and it is lenient about the wrappers MathQuill sometimes puts round letters.
     */
    function isTrigger(latex) {
        return (
            String(latex == null ? "" : latex)
                .replace(/\\(?:operatorname|mathrm|mathit|text)/g, "")
                .replace(/\\[ ,;:!>]/g, "")
                .replace(/[\s{}]/g, "")
                .toLowerCase() === "lua"
        );
    }

    /**
     * Our graph observer. Desmos' unobserveEvent takes an event name and not a callback, so an
     * un-namespaced "change" would take every other extension's observer down with it -
     * extensions/desmosMd watches the same event, and unnamespaced.
     */
    var WATCH = "change.cdeLua";

    /** How long to wait out a burst of typing before writing the text back to the graph. */
    var FLUSH_DELAY = 500;

    /** Every cell on the graph, by expression id. */
    var cells = new Map();

    /** True while we are the ones calling setExpression, so the observer ignores its own echo. */
    var writing = false;

    /** The last text we wrote for each cell, so a flush that would change nothing is skipped. */
    var written = new Map();

    var Calc = null;

    var lua = (window.Extensions && window.Extensions.lua) || {};

    extension(
        Object.assign(lua, {
            id: "lua",

            // Everything this extension changes about Desmos itself.
            patches: [
                // --- the item type ------------------------------------------------
                //
                // Eight places Desmos asks what an item type is. Each answer is the one it
                // already gives for a note, so a Lua cell converts, saves, undoes, re-renders
                // and reloads exactly as a note does.

                // State -> item model. Falls through to the note's own model factory, which
                // spreads the state over the note defaults - so `type` stays "lua".
                {
                    match: /case"text":return (\i)\((\i),(\i)\.controller\);default:return \2\}/,
                    replace: 'case"lua":$&',
                    count: 1
                },
                // The two state normalisers. One of them is the incremental setState path,
                // which throws rather than shrugging - that is version-history restore.
                {
                    match: /case"text":return py\(\i\);/,
                    replace: 'case"lua":$&',
                    count: 2
                },
                // Handing out an id to an item that arrived without one.
                {
                    match: /case"text":return\{\.\.\.(\i),id:\((\i)=\1\.id\)!=null\?\2:(\i)\.generateId\(\)\};/,
                    replace: 'case"lua":$&',
                    count: 1
                },
                // Item model -> saved state. Without this the default returns the *model*,
                // which would put the controller and the guid into the saved graph.
                {
                    match: /case"text":return (\i)\((\i),(\i)\);default:return \2\}/,
                    replace: 'case"lua":$&',
                    count: 1
                },
                // The projection the list keeps beside each item.
                {
                    match: /case"text":return (\i)\((\i)\)\}/,
                    replace: 'case"lua":$&',
                    count: 1
                },
                // The row. Desmos' own note view, whose template hardcodes
                // "dcg-expressiontext" - which is what editor.js finds rows by.
                {
                    match: /else if\((\i)\.type==="text"\)(\i)=l\(XT,/,
                    replace:
                        'else if($1.type==="text"||$1.type==="lua")$2=l(XT,',
                    count: 1
                },
                // setExpression, which is how a cell's text is written back. The note builder
                // hardcodes `type:"text"`, so borrow it and put the type back.
                {
                    match: /case"text":return iJ\((\i),(\i)\);/,
                    replace:
                        'case"lua":{let l=iJ($1,$2);l.type="lua";return l}$&',
                    count: 1
                },

                // --- Lua's exports ----------------------------------------------
                //
                // requestParseForAllItems() builds a map of everything on the graph that has latex
                // in it, then diffs that map against the last one and calls the evaluator's
                // addStatement / removeStatement for whatever changed. Injecting into the map, at
                // the last moment before the diff, means a Lua value is a statement Desmos
                // evaluates like any other - with no item in the expression list, nothing in the
                // saved graph, and nothing on the undo stack.
                //
                // It also means the reaper is Desmos' own: an export this cell no longer makes is
                // simply absent from the map, and the diff removes the statement.
                {
                    match: /(\i)&&\((\i)\[\1\.id\]=\1\);(for\(let \i in )/,
                    replace: "$1&&($2[$1.id]=$1);$self.inject($2);$3",
                    count: 1
                },

                // "lua" in the + menu, beside table - the comparison people reach for.
                //
                // Desmos builds each entry of that menu with one component, so the cheapest way
                // in is to let "lua" take the same path the built-in types take: the icon, the
                // label and the tap all come from Desmos' own button. It asks three questions
                // about a type, two of which throw on one they have not heard of, so all three
                // get an answer. Its tap dispatches `new-lua`, which ready() below answers.
                {
                    match: /(\i)\.push\("table"\),/,
                    replace: '$&$1.push("lua"),',
                    count: 1
                },
                {
                    match: /case"expression":case"note":case"table":case"folder":/,
                    replace: 'case"lua":$&',
                    count: 1
                },
                {
                    match: /getAriaLabel\(\)\{let (\i)=this\.props\.itemType\(\);switch\(\1\)\{/,
                    replace: '$&case"lua":return"Add a Lua cell";',
                    count: 1
                },
                {
                    match: /getIconText\(\)\{let (\i)=this\.props\.itemType\(\);switch\(\1\)\{/,
                    replace: '$&case"lua":return"lua";',
                    count: 1
                },
                {
                    match: /getExpressionIcon\(\)\{switch\(this\.props\.itemType\(\)\)\{/,
                    replace: '$&case"lua":return"dcg-icon-new-note";',
                    count: 1
                }
            ],

            PRAGMA: PRAGMA,

            /** Every cell on the graph, by expression id. Live - do not hold onto it. */
            cells: cells,

            ready: function (calc) {
                Calc = calc;

                // An extension with `patches` is registered as a copy of the object handed to
                // extension() (extensions.js:92), and that copy is the one on the window - so
                // it is the one bridge.js, runner.js and editor.js add themselves to. Follow
                // it, or `lua.bridge` here would be forever undefined.
                lua = window.Extensions.lua;
                lua.Calc = calc;

                menu();

                if (lua.bridge) lua.bridge.init(calc);
                if (lua.editor) lua.editor.init(calc);

                scan();
                Calc.observeEvent(WATCH, scan);

                // The expression list virtualizes, so a row can be torn out and rebuilt
                // without the graph changing at all. `change` never fires for that.
                watchList();
            },

            /** Is this a Lua cell? */
            isCell: isCell,
            pragmas: pragmas,

            /** The cell for an expression id, or undefined. */
            cell: function (id) {
                return cells.get(id);
            },

            /** Every cell, in sheet order. */
            ordered: function () {
                return Array.from(cells.values()).sort(function (a, b) {
                    return a.order - b.order;
                });
            },

            /**
             * The text of a cell has changed in the editor. Keeps the cell up to date now and
             * the graph up to date shortly; runner.js decides separately whether to run it.
             */
            edited: function (id, source) {
                var cell = cells.get(id);
                if (!cell || cell.source === source) return;
                cell.source = source;
                schedule(cell);
                if (lua.runner) lua.runner.edited(cell);
            },

            /** Write a cell's text back to the graph now, if it differs from what is there. */
            flush: flush,

            /** Put a cell where `id` is, converting the expression that is there. */
            convert: convert,

            /** Add a cell after the current selection. The + menu and the console. */
            add: add,

            /**
             * Put every cell's exports into the map Desmos is about to turn into statements.
             * Called from the patch above, so `map` is Desmos' own.
             *
             * Only cells that are switched on contribute: off means a cell is not running, and
             * a definition with no visible source and no cell behind it would be a mystery.
             */
            inject: function (map) {
                cells.forEach(function (cell) {
                    if (!cell.on) return;
                    cell.exports.forEach(function (spec, name) {
                        var id = "cde-lua-" + cell.id + "-" + name;
                        map[id] = {
                            id: id,
                            type: "statement",
                            latex: spec.latex,
                            shouldGraph: spec.plot === true
                        };
                    });
                });
            },

            /**
             * Ask Desmos to look again. Everything a cell exported reaches the graph through
             * this - inject() is only called from inside the parse.
             */
            reparse: reparse
        })
    );

    /** Re-run Desmos' parse, which is what calls inject(). Coalesced into one per turn. */
    var parsing = null;

    function reparse() {
        if (parsing || !Calc) return;
        parsing = setTimeout(function () {
            parsing = null;
            try {
                Calc.controller.requestParseForAllItems();
            } catch (error) {
                console.error(
                    "desmos: couldn't hand Lua's exports to the evaluator",
                    error
                );
            }
        }, 0);
    }

    /**
     * Answer the + menu's Lua entry. Its button is Desmos' own, and Desmos' own button taps by
     * dispatching `new-<type>` - so the entry works by us knowing what `new-lua` means.
     *
     * Wrapping a controller method at runtime rather than patching the reducer: the same shape
     * extensions/matrices uses on getMathquillConfig, and one less pattern to go stale.
     */
    function menu() {
        var controller = Calc.controller;
        var dispatch = controller.dispatch;
        controller.dispatch = function (action) {
            if (action && action.type === "new-lua") {
                add();
                dispatch.call(controller, { type: "close-add-expression" });
                return;
            }
            return dispatch.apply(controller, arguments);
        };
    }

    // -----------------------------------------------------------------------
    // what a cell is
    // -----------------------------------------------------------------------

    function isCell(item) {
        return !!item && item.type === "lua";
    }

    /** The pragmas a cell's source asks for, from its first line if it has such a line. */
    function pragmas(source) {
        var match = PRAGMA.exec(source || "");
        var words = match ? match[1].trim() : "";
        return new Set(words ? words.split(/\s+/) : []);
    }

    // -----------------------------------------------------------------------
    // keeping `cells` and the graph in step
    // -----------------------------------------------------------------------

    /**
     * Read the graph. Adds cells that have appeared, drops cells that have gone, and takes the
     * text of one that changed underneath us - an undo, a setState, a graph load.
     *
     * Runs on every graph change, so it does as little as it can get away with.
     */
    function scan() {
        if (writing) return;

        var list = (Calc.getState().expressions || {}).list || [];
        var seen = new Set();
        var order = 0;

        for (var i = 0; i < list.length; i++) {
            var item = list[i];

            // The trigger: an expression that is just the word. Desmos does this for `table`
            // and `folder`; `lua` is not in autoOperatorNames, so three implicitly multiplied
            // variables is exactly the latex we get.
            if (item.type === "expression" && isTrigger(item.latex)) {
                convert(item);
                continue;
            }

            if (!isCell(item)) continue;
            seen.add(item.id);

            var source = item.text || "";
            var cell = cells.get(item.id);

            if (!cell) {
                cell = {
                    id: item.id,
                    source: source,
                    pragmas: pragmas(source),
                    order: order++,

                    // Off on every load, always. A graph you have just opened is someone
                    // else's code, and Lua reaches the DOM.
                    on: false,

                    node: null,
                    host: null,
                    error: null,

                    // what the last run read, exported, and printed
                    reads: new Set(),
                    exports: new Map(),
                    output: [],

                    co: null,
                    parked: false,
                    stale: false,
                    runs: 0,
                    timer: null
                };
                cells.set(item.id, cell);
                written.set(item.id, item.text);
                // A cell can arrive off the graph already broken; say so before it is ever
                // switched on, rather than only once somebody types in it.
                if (lua.runner) lua.runner.check(cell);
            } else {
                cell.order = order++;
                cell.pragmas = pragmas(source);
                // Changed underneath us - undo, setState, a graph load. Take it, and tell the
                // editor so the box catches up without losing its undo history.
                if (source !== cell.source) {
                    cell.source = source;
                    written.set(item.id, item.text);
                    if (lua.editor) lua.editor.refresh(cell);
                    if (lua.runner) lua.runner.edited(cell);
                }
            }
        }

        cells.forEach(function (cell, id) {
            if (seen.has(id)) return;
            if (lua.runner) lua.runner.forget(cell);
            if (lua.editor) lua.editor.forget(cell);
            cells.delete(id);
            written.delete(id);
        });

        paint();
    }

    /**
     * Turn the expression at `item.id` into an empty cell.
     *
     * Not setExpression: for an item that already exists it dispatches
     * set-expression-properties-from-api against the model that is there, and a type is not one
     * of the properties that can be set - so it silently does nothing. Splicing the list and
     * setting the state back is the way to replace an item with one of another type, and is
     * what settings/tabs/savedGraphs.js does for the same reason.
     */
    function convert(item) {
        var state = Calc.getState();
        var list = (state.expressions || {}).list;
        if (!list) return;

        var at = -1;
        for (var i = 0; i < list.length; i++)
            if (list[i].id === item.id) {
                at = i;
                break;
            }
        if (at === -1) return;

        list[at] = note(item.id, item.folderId);
        commit(state);
        if (lua.editor) lua.editor.focusSoon(item.id);
        rescan();
    }

    /** An empty cell, as an item. */
    function note(id, folderId) {
        var item = { type: "lua", id: String(id), text: "" };
        if (folderId) item.folderId = folderId;
        return item;
    }

    /** A new cell after whatever is selected, or at the end. The + menu's way in. */
    function add() {
        var state = Calc.getState();
        var list = (state.expressions || {}).list;
        if (!list) return null;

        var fresh = note(freshId());
        var at = list.length;

        try {
            var selected =
                Calc.controller.getSelectedItem &&
                Calc.controller.getSelectedItem();
            if (selected) {
                for (var i = 0; i < list.length; i++)
                    if (list[i].id === selected.id) {
                        at = i + 1;
                        break;
                    }
                // A cell added next to something in a folder belongs in that folder.
                if (selected.folderId) fresh.folderId = selected.folderId;
            }
        } catch (error) {
            // The end of the list is a perfectly good answer.
        }

        list.splice(at, 0, fresh);
        commit(state);
        if (lua.editor) lua.editor.focusSoon(fresh.id);
        rescan();
        return fresh.id;
    }

    /** Put a state back, as one undo step rather than a place you cannot get out of. */
    function commit(state) {
        writing = true;
        try {
            Calc.setState(state, { allowUndo: true });
        } finally {
            writing = false;
        }
    }

    /**
     * setExpression, with our echo guard up. For updating a property of an item that already
     * exists - a cell's text - which is all it is used for. It cannot change an item's *type*:
     * see convert().
     */
    function setExpression(spec) {
        writing = true;
        try {
            Calc.setExpression(spec);
        } finally {
            writing = false;
        }
    }

    /**
     * Read the graph again, shortly.
     *
     * Desmos fires `change` from inside setExpression, which is while our own guard is up - so
     * the change we just made is the one scan() is certain not to see. Anything that writes a
     * cell into the graph has to ask for another look afterwards, or a converted expression
     * would sit there as a note nobody had noticed.
     */
    var rescanTimer = null;

    function rescan() {
        if (rescanTimer) return;
        rescanTimer = setTimeout(function () {
            rescanTimer = null;
            scan();
        }, 0);
    }

    /**
     * An id Desmos has not used and will not use again - the same reasoning as
     * settings/tabs/savedGraphs.js: its counter only goes up, so an id freed by a delete is
     * still spoken for.
     */
    function freshId() {
        try {
            var id = Calc.controller.generateId();
            if (id) return id;
        } catch (error) {
            /* fall through */
        }
        return "cde-lua-" + Date.now();
    }

    // -----------------------------------------------------------------------
    // writing the text back
    // -----------------------------------------------------------------------

    /**
     * Wait out a burst of typing, then write. Every setExpression is an undo step, so this is
     * the difference between one Ctrl+Z per pause and one per keystroke.
     */
    function schedule(cell) {
        clearTimeout(cell.timer);
        cell.timer = setTimeout(function () {
            flush(cell.id);
        }, FLUSH_DELAY);
    }

    function flush(id) {
        var cell = cells.get(id);
        if (!cell) return;
        clearTimeout(cell.timer);
        cell.timer = null;

        if (written.get(id) === cell.source) return;
        written.set(id, cell.source);
        setExpression({ id: id, type: "lua", text: cell.source });
    }

    /** Everything pending, now. Before a save, and on the way out. */
    function flushAll() {
        cells.forEach(function (cell) {
            if (cell.timer) flush(cell.id);
        });
    }

    window.addEventListener("beforeunload", flushAll);

    // -----------------------------------------------------------------------
    // the rows
    // -----------------------------------------------------------------------

    /**
     * Hand every cell its row. The list virtualizes, so a row we decorated may have been
     * rebuilt since - `editor.attach` is written to be called again on a row it already owns.
     */
    function paint() {
        if (!lua.editor) return;
        var nodes = document.querySelectorAll(
            ".dcg-expressionitem.dcg-expressiontext"
        );
        var live = new Set();
        nodes.forEach(function (node) {
            var id = node.getAttribute("expr-id");
            var cell = cells.get(id);
            if (!cell) return;
            live.add(id);
            lua.editor.attach(cell, node);
        });
        // A cell whose row is no longer in the document has been scrolled away, not deleted.
        cells.forEach(function (cell, id) {
            if (!live.has(id) && cell.node) lua.editor.detach(cell);
        });
    }

    /**
     * The expression list rebuilds rows as it scrolls, which `change` never hears about. One
     * observer on the list, coalesced into a frame, is cheaper than polling and catches it.
     */
    function watchList() {
        var pending = false;
        var observer = new MutationObserver(function () {
            if (pending) return;
            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                paint();
            });
        });

        var list =
            document.querySelector(".dcg-expressionlist") ||
            document.querySelector(".dcg-exppanel-container") ||
            document.body;
        observer.observe(list, { childList: true, subtree: true });
    }
})();
