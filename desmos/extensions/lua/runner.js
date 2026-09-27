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
// Nothing runs until its toggle is on, and every toggle is off on every load. A graph you
// have just opened is someone else's code, and `--!lua unsafe` hands that code the DOM.
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

    /** Wait out a burst of typing before running. Longer than the flush - running costs more. */
    var RUN_DELAY = 750;

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
        setOn: setOn,
        toggle: toggle,
        run: start,
        stop: stop
    };

    lua.bridge.onWake = wake;
    lua.bridge.onInvalidate = invalidate;

    // -----------------------------------------------------------------------
    // when
    // -----------------------------------------------------------------------

    /** The toggle. Off is the resting state, and the only state a page load can produce. */
    function setOn(cell, on) {
        if (cell.on === on) return;
        cell.on = on;
        if (on) {
            start(cell);
        } else {
            stop(cell);
            // Off contributes nothing. A definition with no running cell behind it and no item
            // in the list to point at would be a value from nowhere.
            cell.exports = new Map();
            lua.reparse();
        }
        render(cell);
    }

    function toggle(cell) {
        setOn(cell, !cell.on);
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

    /** The text changed. Check it parses, then run it once typing stops. */
    function edited(cell) {
        clearTimeout(cell.runTimer);
        if (check(cell) || !cell.on) return;

        cell.runTimer = setTimeout(function () {
            start(cell);
        }, RUN_DELAY);
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

    /** A value a cell read has changed, so everything that read it is out of date. */
    function invalidate(name) {
        var readers = deps.get(name);
        if (!readers) return;
        readers.forEach(function (id) {
            var cell = lua.cell(id);
            if (cell && cell.on) enqueue(cell);
        });
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
        if (!cell.on) return;
        clearTimeout(cell.runTimer);
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
        cell.output = [];
        cell.reads = new Set();
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

        lua.bridge.pushEnv(co);
        if (cell.pragmas.has("unsafe")) {
            lua.bridge.grantJs(co);
            C.lua_setfield(co, -2, to_luastring("js"));
        }
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
        clearTimeout(cell.runTimer);
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
        lua.reparse();
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

    function traceback(cell) {
        var message = C.lua_tojsstring(cell.co, -1) || "error";
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
        return String(message == null ? "error" : message).replace(
            new RegExp("^" + name + ":", "gm"),
            ""
        );
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
