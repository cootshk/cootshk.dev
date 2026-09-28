// When a cell runs, and what happens when it goes wrong.
//
// Each run is its own Lua thread, which is what makes a read of an unevaluated Desmos name
// able to park the cell instead of giving it nil - see bridge.js. It is also what makes a
// runaway cell survivable: a count hook yields every few million instructions and the run
// picks up again on the next frame, so `while true do end` costs a slow cell rather than a
// dead tab. lua_yieldk returns rather than throws when it is called from inside a hook
// (libs/fengari/src/ldo.js:638-649), and luaG_traceexec does the rewind (ldebug.js:663-669);
// that pair is the whole trick.
//
// A cell runs when the graph opens, when the play button in its gutter is clicked, and when a
// value it read changes. It does *not* run because it was edited - typing is not a request to
// execute, and the same keystroke would otherwise run a dozen half-written versions of a line.
//
// The one exception to running at load is `--!lua unsafe`, which grants the cell `js` and with it
// the DOM on this origin. A graph you have just opened is someone else's code, so that pragma
// keeps needing a deliberate click.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    var F = window.fengari;
    var C = F.lua;
    var lauxlib = F.lauxlib;
    var to_luastring = F.to_luastring;
    var L = F.L;

    var THREADS = "cde.lua.threads";

    /** Instructions between breaths. Big enough not to matter, small enough to stay smooth. */
    var BUDGET = 2000000;

    /** How long a single run may go on taking breaths before we call it a runaway. */
    var PATIENCE = 10000;

    /** Re-runs of one cell in a single settling batch before we call it a loop. */
    var SPIN = 20;

    /** How many times a cell may be re-run just to wait for a read it could not answer. */
    var SETTLE = 6;

    /** name -> Set of cell ids that read it on their last run. */
    var deps = new Map();

    /** Set by the count hook, read by step(). */
    var throttled = false;

    /** Cells waiting to run, drained in sheet order. */
    var queue = new Set();
    var draining = false;

    /** Reset every cell's spin counter once the graph has been quiet for a moment. */
    var settle = null;

    lua.runner = {
        check: check,
        edited: edited,
        forget: forget,
        run: start,
        stop: stop,
        toggle: toggle,
        busy: busy,
        blame: blame
    };

    lua.bridge.onWake = wake;
    lua.bridge.onInvalidate = invalidate;
    lua.bridge.onSettle = revisit;

    // -----------------------------------------------------------------------
    // when
    // -----------------------------------------------------------------------

    /** Is a run in flight - going, or parked on a value it is waiting for? */
    function busy(cell) {
        return !!cell.co;
    }

    /**
     * What the gutter button does. Run, or stop a run that is still going: the same play/pause
     * a slider's button is, and the only way a cell starts other than the graph opening.
     *
     * Stopping drops what the part-finished run had exported, because a definition whose cell was
     * interrupted is a value from nowhere.
     */
    function toggle(cell) {
        if (!busy(cell)) return start(cell);
        stop(cell);
        cell.exports = new Map();
        lua.reparse();
        render(cell);
    }

    /**
     * Does this cell parse? Compiling to find out is most of what a syntax marker costs
     * anyway, and it means a half-written line never runs.
     *
     * Called on every edit and once when a cell is first read off the graph - a cell that
     * arrives broken should say so before anyone switches it on.
     */
    function check(cell) {
        cell.syntax = syntax(cell);
        render(cell);
        return cell.syntax;
    }

    /**
     * The text changed. Check that it parses, and stop there.
     *
     * Editing a cell never runs it. The graph is still written to on ./index.js's own debounce -
     * that is storage, and unrelated.
     */
    function edited(cell) {
        check(cell);
    }

    /** Compile without running. Returns an error string, or null. */
    function syntax(cell) {
        var co = C.lua_newthread(L);
        var ok = lauxlib.luaL_loadbuffer(
            co,
            to_luastring(cell.source),
            null,
            to_luastring(chunk(cell))
        );
        var message = ok === C.LUA_OK ? null : C.lua_tojsstring(co, -1);
        C.lua_pop(L, 1);
        return message === null ? null : clean(cell, message);
    }

    /**
     * A value a cell read has changed, so everything that read it is out of date.
     *
     * `from` is the cell that caused it, and it is skipped. A cell that writes a name it also
     * reads - which `a = 2` next to `a * 2` now is, since a plain global write is an export -
     * would otherwise invalidate itself on every run and spin until SPIN stopped it.
     */
    function invalidate(name, from) {
        var readers = deps.get(name);
        if (!readers) return;
        readers.forEach(function (id) {
            if (from && from.id === id) return;
            var cell = lua.cell(id);
            if (cell) enqueue(cell);
        });
    }

    /**
     * A value a probe waited for has landed: run that cell again so its export is built from
     * the number rather than the name. Ignored if the cell has been re-run since - that run
     * asked for whatever it still needs on its own.
     *
     * Bounded, because a body whose reads are different every run - `f(random())` composes a
     * latex nobody has ever asked for each time round - would otherwise never settle. Past the
     * bound the cell keeps whatever it has, which is the fragment it would have had anyway;
     * giving up quietly is better than SPIN calling it a dependency loop and dropping it.
     */
    function revisit(id, gen) {
        var cell = lua.cell(id);
        if (!cell || cell.gen !== gen) return;
        cell.settles = (cell.settles || 0) + 1;
        if (cell.settles > SETTLE) return;
        enqueue(cell);
    }

    function enqueue(cell) {
        queue.add(cell);
        if (draining) return;
        draining = true;
        Promise.resolve().then(drain);
    }

    /**
     * Start every queued cell, in sheet order. They do not *finish* in that order - a cell
     * that parks on a read lets the next one go first - but "later cell sees earlier cell" is
     * the rule that holds, and a cell that read too early is re-run when the value lands.
     */
    function drain() {
        draining = false;
        var batch = lua.ordered().filter(function (cell) {
            return queue.has(cell);
        });
        queue.clear();
        batch.forEach(start);
    }

    // -----------------------------------------------------------------------
    // running
    // -----------------------------------------------------------------------

    function start(cell) {
        stop(cell);

        if (cell.syntax) return;

        // A cell that keeps re-running inside one settling batch is in a loop with something -
        // easy to build once an export feeds a name the cell itself reads.
        cell.runs = (cell.runs || 0) + 1;
        if (cell.runs > SPIN)
            return fail(cell, "dependency loop - this cell keeps re-running");
        quiet();

        cell.gen = (cell.gen || 0) + 1;
        cell.error = null;
        cell.reads = new Set();
        // What a probe read, kept apart from what the cell read. See bridge.read.
        cell.probeReads = new Set();
        cell.exports = new Map();
        cell.stale = false;
        cell.parked = false;
        cell.frames = 0;
        cell.started = Date.now();

        var co = C.lua_newthread(L);
        anchor(cell, co);
        cell.co = co;

        if (
            lauxlib.luaL_loadbuffer(
                co,
                to_luastring(cell.source),
                null,
                to_luastring(chunk(cell))
            ) !== C.LUA_OK
        ) {
            var message = C.lua_tojsstring(co, -1);
            C.lua_pop(co, 1);
            return fail(cell, message);
        }

        lua.bridge.pushEnv(co, cell.pragmas.has("unsafe"));
        C.lua_setupvalue(co, -2, 1);

        C.lua_sethook(co, watchdog, C.LUA_MASKCOUNT, BUDGET);

        render(cell);
        step(cell, 0);
    }

    /**
     * Resume the cell's thread. `nargs` is 1 when a parked read is being handed its value and
     * 0 otherwise - after a watchdog breath there is nothing to hand over.
     */
    function step(cell, nargs) {
        if (!cell.co) return;

        throttled = false;
        lua.bridge.begin(cell);
        var status;
        try {
            status = C.lua_resume(cell.co, null, nargs);
        } catch (error) {
            lua.bridge.finish();
            return fail(
                cell,
                "internal: " + (error && error.message ? error.message : error)
            );
        }
        lua.bridge.finish();

        if (status === C.LUA_YIELD) {
            // Two reasons to be here: the watchdog took a breath, or a read parked. Only the
            // first is ours to pick back up - a parked read waits for its helper.
            if (throttled) breathe(cell);
            return;
        }

        if (status !== C.LUA_OK) return fail(cell, traceback(cell));

        done(cell);
    }

    /** The count hook. Sets the status and returns; luaG_traceexec does the rest. */
    function watchdog(co) {
        throttled = true;
        C.lua_yield(co, 0);
    }

    /** Pick the run back up on the next frame, so the page stays alive while it goes. */
    function breathe(cell) {
        if (Date.now() - cell.started > PATIENCE)
            return fail(
                cell,
                "stopped after " + Math.round(PATIENCE / 1000) + "s"
            );
        cell.frames++;
        render(cell);
        cell.raf = requestAnimationFrame(function () {
            cell.raf = null;
            step(cell, 0);
        });
    }

    /** A helper a parked read was waiting on has reported. */
    function wake(cell, value, gen) {
        if (!cell.co || cell.gen !== gen) return;
        cell.parked = false;
        lua.bridge.pushValue(cell.co, value);
        step(cell, 1);
    }

    function done(cell) {
        release(cell);
        remember(cell);
        // Desmos' own parse picks the exports up from lua.inject(); nothing is written to the
        // graph, so there is nothing here to undo or clean up.
        lua.reparse();

        // A read that could not park - inside a JS callback, or table.sort's comparator - took
        // nil rather than a value. Go round again now that the helper has been made.
        if (cell.stale) {
            cell.stale = false;
            enqueue(cell);
        }

        render(cell);
    }

    function fail(cell, message) {
        release(cell);
        remember(cell);
        // A run that died part-way still made whatever it made before it died; let the graph
        // show that rather than silently keeping the last good set.
        lua.reparse();
        cell.error = clean(cell, message);
        console.error("lua:", cell.error);
        render(cell);
    }

    function stop(cell) {
        if (cell.raf) cancelAnimationFrame(cell.raf);
        cell.raf = null;
        release(cell);
    }

    /** Let the thread go. Its generation has already moved on, so nothing will resume it. */
    function release(cell) {
        if (!cell.co) return;
        cell.co = null;
        cell.parked = false;
        unanchor(cell);
    }

    function forget(cell) {
        stop(cell);
        deps.forEach(function (readers) {
            readers.delete(cell.id);
        });
        cell.exports = new Map();
        if (lua.actions) lua.actions.forget(cell);
        lua.reparse();
    }

    /**
     * An error from outside a run: a body that failed while its action was firing.
     *
     * There is no thread to unwind and no run to fail, but the cell that exported the body is
     * still where the message belongs - so it goes on the gutter icon like any other, and a fix
     * plus a re-run clears it.
     */
    function blame(cell, message) {
        if (!cell) return;
        cell.error = clean(cell, message);
        console.error("lua:", cell.error);
        render(cell);
    }

    /** File this run's reads, so a change to any of them comes back to this cell. */
    function remember(cell) {
        deps.forEach(function (readers) {
            readers.delete(cell.id);
        });
        cell.reads.forEach(function (name) {
            var readers = deps.get(name);
            if (!readers) deps.set(name, (readers = new Set()));
            readers.add(cell.id);
        });
    }

    /** Once the graph stops moving, every cell gets its spin allowance back. */
    function quiet() {
        clearTimeout(settle);
        settle = setTimeout(function () {
            lua.cells.forEach(function (cell) {
                cell.runs = 0;
                cell.settles = 0;
            });
        }, 250);
    }

    // -----------------------------------------------------------------------
    // threads, errors, and telling the editor
    // -----------------------------------------------------------------------

    function chunk(cell) {
        return "@lua:" + cell.id;
    }

    /** Keep the thread reachable from the registry, so it is not collected mid-yield. */
    function anchor(cell, co) {
        C.lua_getfield(L, C.LUA_REGISTRYINDEX, to_luastring(THREADS));
        C.lua_pushvalue(L, -2);
        C.lua_setfield(L, -2, to_luastring(cell.id));
        C.lua_pop(L, 2);
    }

    function unanchor(cell) {
        C.lua_getfield(L, C.LUA_REGISTRYINDEX, to_luastring(THREADS));
        C.lua_pushnil(L);
        C.lua_setfield(L, -2, to_luastring(cell.id));
        C.lua_pop(L, 1);
    }

    /**
     * The error a run died on, with its traceback.
     *
     * The message comes from bridge.describe rather than lua_tojsstring, which answers null for
     * every error value that is not already a string or a number - and so used to turn a bug in
     * this extension into the bare word "error".
     */
    function traceback(cell) {
        var message = lua.bridge.describe(cell.co);
        try {
            lauxlib.luaL_traceback(L, cell.co, to_luastring(message), 1);
            var full = C.lua_tojsstring(L, -1);
            C.lua_pop(L, 1);
            return full || message;
        } catch (error) {
            return message;
        }
    }

    /** `lua:7:3: message` reads better as `3: message`, and the id is on the row already. */
    function clean(cell, message) {
        var name = chunk(cell)
            .slice(1)
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return String(
            message == null ? "it stopped without saying why" : message
        ).replace(new RegExp("^" + name + ":", "gm"), "");
    }

    /**
     * The line an error points at. The chunk is the cell's body and nothing else - the sentinel
     * never reaches the compiler - so Lua's line numbers are the editor's line numbers.
     */
    lua.runner.line = function (cell, message) {
        // clean() has taken the chunk name off, so the number is what is left at the front.
        var m = /^\s*(\d+):/.exec(message || "");
        return m ? Math.max(1, Number(m[1])) : null;
    };

    function render(cell) {
        if (lua.editor) lua.editor.render(cell);
    }
})();
