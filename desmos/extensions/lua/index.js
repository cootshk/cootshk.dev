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
// A cell is one of Desmos' own notes with a `lua: true` flag on it, and `text` is the Lua
// source, verbatim.
//
// Not a custom `type: "lua"` item, which this briefly was. Desmos asks what an item type is in
// some fifty places; a custom type has to answer seventeen of them, and seven of those are `for`
// loops over every item model whose `switch` ends in `default: return` - which do not skip a
// type they have not met, they end the loop, so every item after a cell silently stops being
// updated. One of them populates the saved state, so a cell was invisible to getState(); another
// is the parse this extension injects its exports into, so a cell broke its own statements.
//
// A flag on a note costs two patches instead, both only about making the flag persist: a note's
// saved state is built from a fixed field list, and its undo restoration copies a fixed prop
// set. Everything else is a note, and all fifty of those places already know what a note is.
//
// The flag survives the rest untouched, which is worth knowing before moving it: the state
// normaliser is a deep clone, and the strip-defaults pass iterates the object rather than the
// defaults, so a key the defaults have never heard of is kept. setExpression merges the fields
// it is given, so writing `text` back does not disturb `lua`.
//
// `text` carries the source rather than a field of its own for the same reason the flag is
// cheap: `text` is already in both of those lists.
//
// The source is the chunk. Nothing is stripped from it, so Lua's line 3 is the editor's line 3.
// A first line of `--!lua <pragmas>` is read for pragmas and then left exactly where it is -
// it is a Lua comment, so the compiler does not care, and nothing has to count lines.
//
// With this extension off, a cell is a note with readable Lua in it. Nothing is lost.
(function () {
    /**
     * A definition on the graph, as its latex reads: `a=5`, `a_{1}=5`, `f\left(x\right)=x^{2}`.
     * The bracketed group is what separates a function from a value, and its absence is what
     * separates `y=x^{2}` from `x^{2}+y^{2}=1` - the latter has no name on the left at all.
     */
    var DEFINE =
        /^\s*([A-Za-z](?:_\{[A-Za-z0-9]+\}|_[A-Za-z0-9])?)\s*(\\left\([^=]*?\\right\))?\s*=/;

    /**
     * What makes a definition an *action* rather than a value: a `\to` on the right of the `=`.
     * `Y=a\to3` is something to run, not a number to wait for, and reading it as the second is
     * how a Lua cell used to get `NaN` out of it.
     *
     * The lookahead keeps `\to` from matching the start of a longer macro; Desmos has none, but
     * the same guard is on Desmos' own reader of this.
     */
    var ACTION = /\\to(?![a-zA-Z])/;

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
     * Desmos name -> the id of the *item* defining it. Rebuilt with the definitions index.
     *
     * Items only, never a cell's exports: this is what tells a Lua write whether it is moving
     * something of Desmos' or holding something of its own.
     */
    var sites = new Map();

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
                // --- what marks a cell ------------------------------------------
                //
                // A cell is one of Desmos' own notes carrying a `lua: true` flag. Two patches,
                // both about making that flag persist:
                //
                //   - a note's saved state is built by one function from a fixed list of
                //     fields, so `lua` is added to that list;
                //   - and its undo restoration copies a fixed set of props, so `lua` is added
                //     to that set too.
                //
                // Everything else about the item is a note, natively: Desmos asks what an item
                // type is in some fifty places, and all fifty already know what a note is. A
                // custom `type` would have had to answer seventeen of them, seven being loops
                // over every item model whose `default:` is a `return` - which do not skip an
                // unknown type, they end the loop, so every item after a cell would silently
                // stop updating. None of that exists here.
                //
                // It also means a graph opened without this extension shows its cells as notes
                // with readable Lua in them, rather than as items Desmos cannot model.
                {
                    match: /(\i)\.cachedViewState=\{type:\1\.type,id:\1\.id,folderId:\1\.folderId,text:\1\.text,/,
                    replace: "$&lua:$1.lua,",
                    count: 1
                },
                {
                    match: /\{id:!1,type:!1,folderId:!0,text:!0,secret:!0,readonly:!0\}/,
                    replace:
                        "{id:!1,type:!1,folderId:!0,text:!0,secret:!0,readonly:!0,lua:!0}",
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

                // --- actions ----------------------------------------------------
                //
                // The one line where Desmos applies an action's updates. They arrive from the
                // evaluator keyed by identifier and valued with the whole new latex of each
                // assignment (`a=4`), and this loop hands each to updateLatexForIdentifier.
                //
                // Getting in front of that loop is what lets a Lua function *be* an action. A
                // cell exports a marker - see ../lua/actions.js - and seeing that marker here
                // means the body runs now, inside this fire, with its updates folded into the
                // same map. So Desmos applies its updates and Lua's together: no frame of lag,
                // one pre-action state behind every right-hand side, and a target named twice is
                // caught before anything moves.
                //
                // Nothing else is touched, and an action with no Lua in it walks straight past.
                {
                    match: /if\((\i)\.eventUpdates\)\{for\(let (\i) of /,
                    replace:
                        "if($1.eventUpdates){$self.actionUpdates($1.eventUpdates.updates);" +
                        "for(let $2 of ",
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

                if (lua.builtins) lua.builtins.init(calc);
                if (lua.bridge) lua.bridge.init(calc);
                if (lua.actions) lua.actions.init(calc);
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
             * A cell that has not run has nothing in its exports, so there is nothing to gate on
             * here - the reaper is Desmos' own diff either way.
             */
            inject: function (map) {
                cells.forEach(function (cell) {
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
                // An action being stepped right now, for the one parse that has to see it. See
                // step(): it is gone again before the next.
                steps.forEach(function (latex, id) {
                    map[id] = {
                        id: id,
                        type: "statement",
                        latex: latex,
                        shouldGraph: false
                    };
                });
            },

            /**
             * Ask Desmos to look again. Everything a cell exported reaches the graph through
             * this - inject() is only called from inside the parse.
             */
            reparse: reparse,

            /**
             * The id of the expression defining `name`, or null when nothing on the sheet does.
             *
             * This is the whole of "who owns a value". A name a real item defines is Desmos' -
             * Lua updates it the way an action would - and a name nothing defines is Lua's to
             * publish and to hold. Only items count: a cell's own exports are statements, and a
             * statement has no latex of Desmos' to rewrite.
             */
            defining: function (name) {
                return sites.get(canonical(name)) || null;
            },

            /**
             * Hold a new value for a Lua-owned name - one with no item behind it - by rewriting
             * the export that publishes it. One statement per name either way, so Desmos' own
             * reaper still works and there is never a second definition to collide with.
             */
            own: own,

            /** Run a Desmos action by its latex. See actions.js's call(). */
            step: step,

            /** The applier patch above lands here. */
            actionUpdates: function (updates) {
                if (lua.actions) lua.actions.updates(updates);
                return updates;
            }
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
        return !!item && item.type === "text" && !!item.lua;
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

        var list = items();
        var seen = new Set();
        var order = 0;

        // Cells that were not on the graph a moment ago, in sheet order. Started below, once the
        // whole list has been read and the definitions index is complete - a cell's first run
        // has to be able to see the functions and values it is about to ask for.
        var fresh = [];

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

                    node: null,
                    host: null,
                    error: null,

                    // what the last run read and exported
                    reads: new Set(),
                    exports: new Map(),

                    co: null,
                    parked: false,
                    stale: false,
                    runs: 0,
                    timer: null
                };
                cells.set(item.id, cell);
                written.set(item.id, item.text);
                // A cell can arrive off the graph already broken; say so straight away, rather
                // than only once somebody types in it.
                if (lua.runner) lua.runner.check(cell);
                fresh.push(cell);
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

        index(list);
        paint();
        if (fresh.length) wake(fresh);
    }

    /**
     * Start cells that have just appeared - which at page load is all of them.
     *
     * Deferred out of the dispatch that brought us here: starting a run calls reparse(), and
     * Desmos is in the middle of its own state change. A cell asking for `unsafe` is left alone;
     * that pragma hands Lua `js`, and so the DOM on this origin, and a graph someone else wrote
     * should not get that for the price of being opened.
     */
    function wake(fresh) {
        setTimeout(function () {
            fresh.forEach(function (cell) {
                if (!cells.get(cell.id)) return;
                if (cell.pragmas.has("unsafe")) return;
                if (lua.runner) lua.runner.run(cell);
            });
        }, 0);
    }

    /**
     * Rebuild the index a Lua read is answered from: every name the graph defines, and whether
     * it is a value to wait for or a function to call.
     *
     * A cell's own exports go in too. They are statements rather than items, so they are not in
     * the list - but `Desmos.k = 5` in one cell is exactly the sort of thing the next cell means
     * to read, and without this it would read nil.
     */
    function index(list) {
        if (!lua.bridge) return;
        var defs = lua.bridge.defs;
        defs.clear();

        sites.clear();

        list.forEach(function (item) {
            if (!item) return;
            if (item.type === "expression") return mark(item.latex, item.id);
            // A table's columns are definitions as much as an expression is.
            if (item.type === "table" && item.columns)
                item.columns.forEach(function (column) {
                    if (column && column.latex)
                        mark(column.latex + "=", item.id);
                });
        });

        // After the items, and never over them. A cell exporting a name the sheet already
        // defines is a duplicate definition either way - Desmos will say so - but the item is
        // the real one, so a read must not be answered as if the export had replaced it.
        cells.forEach(function (cell) {
            cell.exports.forEach(function (spec) {
                // No id: an export is a statement, so there is no latex of Desmos' behind it.
                mark(spec.latex, null);
            });
        });

        function mark(latex, id) {
            var text = String(latex == null ? "" : latex);
            var m = DEFINE.exec(text);
            if (!m) return;

            var name = canonical(m[1]);
            if (!id && sites.has(name)) return;

            var isFunction = !!m[2];
            var isAction = ACTION.test(text.slice(m[0].length));

            defs.set(
                name,
                isAction
                    ? isFunction
                        ? "actionFunction"
                        : "action"
                    : isFunction
                      ? "function"
                      : "value"
            );
            if (id) sites.set(name, id);
        }
    }

    /**
     * A new value for a Lua-owned name: find the export that publishes it and rewrite it.
     *
     * This is where an action's update lands when the name it names has no item - a `k` a cell
     * brought into being rather than one the sheet declares. Rewriting the export rather than
     * keeping a value of our own means there is still exactly one statement per name, so Desmos'
     * own reaper takes it away when the cell stops exporting it.
     */
    function own(name, latex) {
        var target = canonical(name);
        var found = false;

        cells.forEach(function (cell) {
            var spec = cell.exports.get(key(target));
            if (!spec) return;
            spec.latex = target + "=" + latex;
            found = true;
        });

        if (found) reparse();
        return found;
    }

    /**
     * Run a Desmos action by its latex.
     *
     * An action the sheet has as an item is Desmos' own to step, and `action-single-step` is what
     * its button dispatches - so that path is Desmos', undo behaviour and all. Anything else is a
     * call no item spells, so it is handed to the evaluator as a statement of ours and stepped the
     * same way. The parse is synchronous here rather than on reparse()'s timeout, because the
     * statement has to exist before the event naming it does.
     */
    var steps = new Map();
    var stepId = 0;

    function step(latex) {
        if (!Calc) return false;

        var id = sites.get(canonical(latex));
        if (id) {
            Calc.controller.dispatch({ type: "action-single-step", id: id });
            return true;
        }

        var mine = "cde-lua-step-" + stepId++;
        steps.set(mine, latex);
        try {
            Calc.controller.requestParseForAllItems();
            Calc.controller.evaluator.addActionStepEvent(mine);
            return true;
        } catch (error) {
            console.error("desmos: couldn't step the action " + latex, error);
            return false;
        } finally {
            // One step, then gone: a transient statement that outlived its event would be a
            // definition nobody asked for.
            steps.delete(mine);
        }
    }

    /** An export map key, the same way bridge.js spells one. */
    function key(latex) {
        return latex.replace(/[^A-Za-z0-9]/g, "");
    }

    /** `a_1` and `a_{1}` are the same name; the index holds the second spelling. */
    function canonical(name) {
        var m = /^([A-Za-z])(?:_\{?([A-Za-z0-9]+)\}?)?$/.exec(name);
        if (!m) return name;
        return m[2] ? m[1] + "_{" + m[2] + "}" : m[1];
    }

    /**
     * Every item on the graph, live.
     *
     * Deliberately not getState(). A note's saved state is a cache - `cachedViewState` - that
     * Desmos rebuilds once a frame, while setExpression sets the model's `text` immediately. So
     * for the rest of the frame in which we write a cell back, getState() still reports the
     * *previous* text. Read then, it looks exactly like someone editing the cell underneath us,
     * and scan() dutifully "corrects" the cell to the stale value: for a cell that began empty,
     * that is its text vanishing the moment focus leaves it.
     *
     * The item models have no such lag, and they are what the saved state is built from.
     */
    function items() {
        try {
            var live = Calc.controller.getAllItemModels();
            if (live && typeof live.length === "number") return live;
        } catch (error) {
            // Fall back on the state; a frame of lag beats not working at all.
        }
        return (Calc.getState().expressions || {}).list || [];
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

    /** An empty cell, as an item: a note that says it is one. */
    function note(id, folderId) {
        var item = { type: "text", id: String(id), text: "", lua: true };
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
        // `lua` is not resent: the reducer applies only the fields it is handed, so the flag
        // on the model is left alone.
        setExpression({ id: id, type: "text", text: cell.source });
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
