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
// A cell is a note - `type: "text"` - whose text begins `--!lua`. That is a deliberate choice
// over inventing a `type: "lua"` item:
//
//   - `--!lua` is a Lua comment, so the note's text *is* the chunk. Nothing is reassembled and
//     nothing is escaped; the bytes in the graph are the bytes the VM compiles.
//   - Notes round-trip through getState/setState, Desmos' undo stack, this site's .dcg files
//     and desmos.com's own save. An item type Desmos has never heard of survives none of
//     those, and the first one it fails is `settings/tabs/savedGraphs.js`, which setStates the
//     whole graph every time it writes metadata.
//   - With this extension off, a cell is a note you can still read. Nothing is lost.
//
// The sentinel is not part of the chunk: `parse` slices it off, and what the VM compiles is
// exactly what the editor holds. So an error on Lua line 3 is an error on editor line 3, and
// there is no arithmetic to get wrong.
(function () {
    /** The first line of a cell. Anything after the word is a pragma - see `pragmas`. */
    var SENTINEL = /^--!lua([ \t][^\n]*)?(?:\n|$)/;

    /** What the sentinel line says when we write one ourselves. */
    var HEADER = "--!lua";

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

            SENTINEL: SENTINEL,
            HEADER: HEADER,

            /** Every cell on the graph, by expression id. Live - do not hold onto it. */
            cells: cells,

            ready: function (calc) {
                Calc = calc;
                lua.Calc = calc;

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
            parse: parse,
            compose: compose,

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

            /** Add a cell after the current selection. The console's way in. */
            add: function () {
                var id = String(freshId());
                setExpression({ id: id, type: "text", text: HEADER + "\n" });
                rescan();
                return id;
            }
        })
    );

    // -----------------------------------------------------------------------
    // what a cell is
    // -----------------------------------------------------------------------

    function isCell(item) {
        return !!item && item.type === "text" && SENTINEL.test(item.text || "");
    }

    /**
     * Split a note's text into the pragmas on its sentinel line and the Lua below it. Returns
     * null for a note that is not a cell.
     */
    function parse(text) {
        var match = SENTINEL.exec(text || "");
        if (!match) return null;
        var words = (match[1] || "").trim();
        return {
            pragmas: new Set(words ? words.split(/\s+/) : []),
            source: (text || "").slice(match[0].length)
        };
    }

    /** The other way: a sentinel line and its pragmas, then the body. */
    function compose(pragmas, source) {
        var words = Array.from(pragmas || []);
        return (
            HEADER + (words.length ? " " + words.join(" ") : "") + "\n" + source
        );
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
            if (item.type === "expression" && item.latex === "lua") {
                convert(item);
                continue;
            }

            if (!isCell(item)) continue;
            seen.add(item.id);

            var parsed = parse(item.text);
            var cell = cells.get(item.id);

            if (!cell) {
                cell = {
                    id: item.id,
                    source: parsed.source,
                    pragmas: parsed.pragmas,
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

                    // export id -> the latex we last wrote for it, so a write that
                    // would change nothing is skipped and the undo stack stays short
                    written: new Map(),

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
                cell.pragmas = parsed.pragmas;
                // Changed underneath us - undo, setState, a graph load. Take it, and tell the
                // editor so the box catches up without losing its undo history.
                if (parsed.source !== cell.source) {
                    cell.source = parsed.source;
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

    /** Turn the expression at `item.id` into an empty cell. */
    function convert(item) {
        setExpression({ id: item.id, type: "text", text: HEADER + "\n" });
        // The conversion is its own undo step, so Ctrl+Z gives the expression back.
        if (lua.editor) lua.editor.focusSoon(item.id);
        rescan();
    }

    /**
     * setExpression, with our echo guard up. Desmos changing an item's type in place is the
     * thing to watch here; if it ever refuses, this is the one place that has to learn the
     * getState/splice/setState way round.
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

        var text = compose(cell.pragmas, cell.source);
        if (written.get(id) === text) return;
        written.set(id, text);
        setExpression({ id: id, type: "text", text: text });
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
