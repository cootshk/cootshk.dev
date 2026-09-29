// The bridge: what Lua sees of the graph, and what the graph sees of Lua.
//
// Reading is the interesting direction. A Desmos value arrives asynchronously - the evaluator
// is a worker - but a Lua global read is synchronous, so `x = a + 1` at the top of a cell has
// to do something about a value that is not there yet. It yields:
//
//   fengari supports yielding out of an __index metamethod. luaV_finishOp (libs/fengari/src/
//   lvm.js:112) has an arm for OP_GETTABUP / OP_GETTABLE / OP_SELF that drops the resumed
//   value into place and carries on with the interrupted opcode, and lua_resume clears
//   L.nny so the yield is allowed in the first place (ldo.js:596).
//
// So a cell runs on its own thread, a read of an unevaluated name parks it, and the helper
// firing resumes it with the value. The cell reads as if it were synchronous. Two things do
// not yield - a JS callback and a non-yieldable library call like table.sort's comparator -
// and lua_isyieldable is the test; there the read gives nil and the cell is marked stale, to
// be re-run from the top once the value lands.
//
// Every cell shares one set of globals and keeps its own locals. The globals live in a table of
// their own, and both `_G` and a cell's own environment are empty tables in front of it wearing
// the same __index/__newindex - so a write is seen by the next cell to read, and a read is
// recorded as a dependency even when an earlier cell put the value there. A metatable on a table
// that also *holds* the values could not do that: a rawget hit never reaches __index.
//
// Writing exports. `a = 2` puts 2 in the globals and `a=2` on the graph, and so does
// `_G.a = 2` and `Desmos.a = 2`. A value that has no Desmos spelling - a function, a string, a
// table of neither points nor numbers - is stored and not exported, silently, because
// `function f(x) ... end` is a global write and cross-cell functions are the point of sharing
// globals at all. `Desmos.k = v` is the strict door: it errors rather than skipping, because it
// asks for the graph outright instead of as a side effect of not writing `local`.
//
// An export never becomes an item in the expression list. It is handed straight to Desmos'
// evaluator as a statement - see the patch in ./index.js - so it leaves nothing in the saved
// graph, nothing on the undo stack, and no folder to tidy up.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    var F = window.fengari;
    var C = F.lua;
    var lauxlib = F.lauxlib;
    var to_luastring = F.to_luastring;
    var L = F.L;

    /** Registry keys. The Lua state is shared with anything else on the page, so namespace. */
    var STORE = "cde.lua.store";
    var THREADS = "cde.lua.threads";
    var GLOBALS = "cde.lua.globals";
    var DESMOS = "cde.lua.desmos";

    /**
     * A Desmos name, as Lua spells it. A Desmos identifier is one letter and an optional
     * subscript, so `a` is `a` and everything after the first letter is the subscript: `abcd`
     * and `a_bcd` both mean `a_{bcd}`. A name that cannot be one - `_x`, `a_`, `x2y` is fine but
     * `1x` is not - is never asked about, which is what keeps `pairs` and `_G` off the graph.
     */
    var NAME = /^([A-Za-z])(?:_?([A-Za-z0-9]+))?$/;

    /**
     * A name ./actions.js made up rather than one the graph has: `L_{p0}` for a parameter a
     * probe is standing in for, `L_{ua3}` for an action's own marker. Nothing defines either,
     * so nothing is worth asking about a latex that mentions one.
     */
    var MARKER = /L_\{(?:p|ua)\d+\}/;

    /** latex -> { h, ready, value, wake: [], used }. One HelperExpression per latex asked for. */
    var helpers = new Map();

    /**
     * A HelperExpression has two channels and both of them are numeric: `numericValue`, and
     * `listValue` for a list of numbers. Anything else has nowhere to arrive.
     *
     * Desmos squeezes what it can down the list channel - a point comes through as its two
     * coordinates, an rgb colour as its three, a tone as its two - but a *list* of any of those
     * fits neither channel, and nor does a polygon. Those all used to reach Lua as the NaN
     * `numericValue` was left holding, and they are read off the model instead. See valueOf().
     *
     * The table below is the one thing the shape of the value cannot tell us: which types are
     * made of *coordinates*, so that `[1, 2]` inside one is a point rather than a pair of
     * numbers. An rgb colour is three numbers and a tone is two, and calling either a point
     * would be a guess at what it means - so they keep their shape, and only these do not.
     * The names are Desmos' own `expression_type`.
     */
    var POINTED = {};
    (
        "SINGLE_POINT POINT_LIST POINT3D POINT3D_LIST POLYGON " +
        "VECTOR2D VECTOR3D SEGMENT3D TRIANGLE3D"
    )
        .split(" ")
        .forEach(function (name) {
            POINTED[name] = true;
        });

    /** A point's coordinates, in order, as Desmos spells them. */
    var COORDS = ["x", "y", "z"];

    /**
     * Past this many live helpers the oldest unparked ones are let go. Reachable now that a call
     * is keyed by its argument: `f(1)` and `f(2)` are two different latexes to watch.
     */
    var HELPER_CAP = 500;

    /** How many to let go at once, so eviction is not a scan of the whole map per new helper. */
    var EVICT = 64;

    /** Bumped on every read, so the least recently used helper is the one to drop. */
    var clock = 0;

    /** Whether listen() has managed to subscribe yet. One subscription for the page. */
    var listening = false;

    /** Whether a re-read is already queued for the end of this dispatch. See recheck(). */
    var pending = false;

    /**
     * Desmos latex name -> "value" | "function". Filled by ./index.js on every graph change from
     * the item list and from what the cells currently export, so a read knows whether a name is
     * a number to wait for, something to call, or nothing at all.
     */
    var defs = new Map();

    /** The cell whose thread is running right now, so reads know whose dependency they are. */
    var current = null;

    var Calc = null;

    lua.bridge = {
        init: init,
        pushEnv: pushEnv,
        pushValue: pushValue,
        begin: begin,
        finish: finish,
        names: names,
        defs: defs,

        /** ./index.js calls this on every graph change; see resync(). */
        resync: resync,

        /** Why something failed, in words. runner.js and actions.js both report errors. */
        describe: describe,

        /** actions.js needs these: it spells Lua values as latex too. */
        toDesmos: toDesmos,
        num: num,
        toLatex: toLatex,

        /** The other way, for items.js and the editor's completion list. */
        toName: toName,
        current: function () {
            return current;
        },

        /** runner.js fills these in. */
        onWake: null,
        onInvalidate: null,
        onSettle: null
    };

    function init(calc) {
        Calc = calc;
        listen();

        if (typeof Calc.HelperExpression !== "function")
            console.warn(
                "desmos: Calc.HelperExpression is missing, so Lua cells cannot read the graph"
            );

        // The shared globals. Not any cell's environment - those sit in front of this one - so
        // that every read and write still goes through a metamethod.
        C.lua_createtable(L, 0, 0);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(STORE));

        // Somewhere to anchor running threads, so they are not collected mid-yield.
        C.lua_createtable(L, 0, 0);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(THREADS));

        // And _G itself, once, so every cell is handed the same table.
        C.lua_pushnil(L);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(GLOBALS));

        // Likewise `Desmos`, which used to be a fresh table per cell. One table, because
        // `Desmos` and `_G.Desmos` have to be the same object - a cell that reaches the second
        // one is asking for the first - and because a single object is a single place to look
        // when a builtin has to behave differently inside an action body.
        C.lua_pushnil(L);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(DESMOS));
    }

    // -----------------------------------------------------------------------
    // the environment a cell runs in
    // -----------------------------------------------------------------------

    /**
     * Push the environment table for a chunk. Empty apart from the standard library, with a
     * metatable, so *every* global read and write in the cell comes through us - which is what
     * makes both "cell 2 sees what cell 1 defined" and "cell 2 re-runs when cell 1 changes it"
     * fall out of the same hook.
     *
     * One table per chunk rather than _G itself, for one reason: `js` is granted per cell, by the
     * `unsafe` pragma, and it must not be visible to the cell next door. Everything else about
     * the table is shared, because everything else goes through the metatable.
     *
     * The order here is the whole of that guarantee. Everything seeded goes in *before* the
     * metatable does, so it lands in this table and nowhere else. Setting any of it afterwards
     * would go through __newindex into the shared globals instead - which is exactly what `js`
     * used to do, handing the DOM to every cell on the graph the moment one asked for it, and
     * spinning the asking cell against its own write until the loop guard stopped it.
     */
    function pushEnv(co, unsafe) {
        C.lua_createtable(co, 0, 16);
        seed(co);
        if (unsafe) {
            grantJs(co);
            C.lua_setfield(co, -2, to_luastring("js"));
        }

        pushMeta(co);
        C.lua_setmetatable(co, -2);
    }

    /** The metatable behind a cell's environment and behind _G. The same one, deliberately. */
    function pushMeta(co) {
        C.lua_createtable(co, 0, 3);
        C.lua_pushcfunction(co, envIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, envNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        // Not readable from Lua, so a cell cannot lift our functions out of it.
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));
    }

    /**
     * The standard library a cell starts with. Set before the metatable is on, so none of it is
     * seen by __newindex - see pushEnv.
     *
     * What is left out is left out on purpose. `debug` reaches upvalues and the registry and
     * so escapes any sandbox at all; `load`, `require` and `dofile` build an environment of
     * their own; `io`, `os.execute` and `package` are not this page's to offer. `js` - the
     * whole DOM - is behind the `unsafe` pragma; see ../lua/README.md.
     */
    function seed(co) {
        var safe = [
            "assert",
            "error",
            "ipairs",
            "next",
            "pairs",
            "pcall",
            "xpcall",
            "select",
            "tonumber",
            "tostring",
            "type",
            "unpack",
            "math",
            "string",
            "table",
            "coroutine",
            "utf8"
        ];

        C.lua_rawgeti(co, C.LUA_REGISTRYINDEX, C.LUA_RIDX_GLOBALS);
        safe.forEach(function (name) {
            var key = to_luastring(name);
            C.lua_getfield(co, -1, key);
            if (C.lua_isnil(co, -1)) {
                C.lua_pop(co, 1);
                return;
            }
            C.lua_setfield(co, -3, key);
        });
        C.lua_pop(co, 1);

        // `_G` is the shared view rather than the real globals table: a cell writing _G.x is
        // talking to the other cells and to the graph, not to the page. Same metatable as the
        // cell's own environment, so `x = 1` and `_G.x = 1` are one mechanism.
        pushGlobals(co);
        C.lua_setfield(co, -2, to_luastring("_G"));

        C.lua_pushcfunction(co, luaPrint);
        C.lua_setfield(co, -2, to_luastring("print"));
        C.lua_pushcfunction(co, luaWarn);
        C.lua_setfield(co, -2, to_luastring("warn"));

        pushDesmos(co);
        C.lua_setfield(co, -2, to_luastring("Desmos"));
    }

    /** The one `Desmos`, made on first use and kept in the registry. See init(). */
    function pushDesmos(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(DESMOS));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        buildDesmos(co);

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(DESMOS));
    }

    /** The one _G, made on first use and kept in the registry. */
    function pushGlobals(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(GLOBALS));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 0);
        pushMeta(co);
        C.lua_setmetatable(co, -2);

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(GLOBALS));
    }

    /** `js`, for a cell whose sentinel line says `unsafe`. Only ever called from pushEnv. */
    function grantJs(co) {
        C.lua_rawgeti(co, C.LUA_REGISTRYINDEX, C.LUA_RIDX_GLOBALS);
        C.lua_getfield(co, -1, to_luastring("js"));
        C.lua_remove(co, -2);
    }

    // -----------------------------------------------------------------------
    // reads
    // -----------------------------------------------------------------------

    /**
     * __index, for both a cell's environment and _G: another cell's global, then the graph.
     *
     * A name the graph does not define at all is nil rather than a helper read. That is not only
     * cheaper - it is the Lua-shaped answer. A helper for an undefined name reports NaN, and NaN
     * is a number, so it is truthy: `if not cache then cache = {} end` would never run its
     * body. The dependency is recorded anyway, so the cell still re-runs if the name appears.
     */
    function envIndex(co) {
        if (C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }
        var name = C.lua_tojsstring(co, 2);

        // `Desmos` itself, so `_G.Desmos` is the table the cell was seeded with rather than the
        // graph's `D_{esmos}`. One object, so there is one thing to reach for either way.
        if (name === "Desmos") {
            pushDesmos(co);
            return 1;
        }

        var latex = toLatex(name);
        var kind = latex === null ? undefined : defs.get(latex);

        // The shared globals. Recorded as a dependency the same way a Desmos name is, so cell 1
        // changing `x` re-runs cell 2.
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_getfield(co, -1, to_luastring(name));
        if (!C.lua_isnil(co, -1)) {
            C.lua_remove(co, -2);
            if (current) {
                current.reads.add("_:" + name);
                // A name an expression also defines: this copy is a cell's own write from a
                // moment ago, kept so the rest of that cell reads what it just set. The graph is
                // what outlives it, so watch the graph too - otherwise a name Lua has ever
                // written is a name Lua stops watching, and `a\to1` on the sheet moves an `a`
                // that no cell ever hears about again. forget() drops the copy when that lands.
                //
                // The dependency is not enough on its own: nothing reports a change until there
                // is a helper watching for it, and the copy answering here is exactly the case
                // where read() never made one.
                if (kind !== undefined) {
                    note(latex);
                    helper(latex);
                }
            }
            return 1;
        }
        C.lua_pop(co, 2);

        if (latex === null) return builtin(co, name);
        // Which *kind* of thing this name is - a value, a function, an action, nothing at all -
        // is itself something to re-run for, so it is filed whether or not a value is read.
        note(latex);
        if (kind === "function") {
            pushCall(co, latex);
            return 1;
        }
        // An action is not a value to wait for, it is something to run.
        if (lua.actions && (kind === "action" || kind === "actionFunction")) {
            lua.actions.pushAction(co, latex, kind === "actionFunction");
            return 1;
        }
        if (kind === undefined) return builtin(co, name);
        return read(co, latex);
    }

    /**
     * A name the graph does not define: Desmos' own functions, then nil.
     *
     * `_G` falling back to `Desmos` is what makes a top-level `sin` mean `\sin` rather than
     * `s_{in}`. It is only reached once `defs` has had its say, so a graph that really does
     * define `s_{in}` still wins - the fallback is for a name that would otherwise be nil.
     */
    function builtin(co, name) {
        if (lua.builtins && lua.builtins.has(name)) {
            pushBuiltin(co, name);
            return 1;
        }
        C.lua_pushnil(co);
        return 1;
    }

    /** A Lua function standing for one of Desmos', with the name riding along as its upvalue. */
    function pushBuiltin(co, name) {
        C.lua_pushstring(co, to_luastring(name));
        C.lua_pushcclosure(co, callBuiltin, 1);
    }

    /**
     * `Desmos.arctan(1)` - or just `arctan(1)`, since `_G` falls back.
     *
     * **Numbers first.** A call whose arguments are all numbers Lua already holds is closed
     * form - it names nothing the graph has to look up - so it is arithmetic, and ./builtins.js
     * does it here, on this thread. The answer is a number, in a cell body and in an action body
     * alike. That is what keeps `floor(random()*100)` a number: written down as latex it would
     * be Desmos' arithmetic at fire time, which for `random` is a different roll every fire and
     * for everything else is a formula where a value was asked for.
     *
     * **Latex is what is left.** An argument that is a fragment - a graph name a body read cold,
     * a parameter during the symbolic probe - has no number to compute with, and the call is a
     * formula because it genuinely is one. That is the case value() is for.
     */
    function callBuiltin(co) {
        var name = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        var n = C.lua_gettop(co);

        // Both spellings at once: the latex Desmos takes, and the numbers behind it where there
        // are any. `numbers` goes null at the first argument that is not one.
        var parts = [];
        var numbers = [];
        for (var i = 1; i <= n; i++) {
            var arg = toDesmos(co, i);
            if (arg.error)
                return fail(
                    co,
                    "cannot pass that to " + name + ": " + arg.error
                );
            parts.push(arg.latex);

            if (!numbers) continue;
            var known = toJS(co, i);
            if (known === undefined) numbers = null;
            else numbers.push(known);
        }

        var latex = lua.builtins.latex(name, parts);
        if (latex === null)
            return fail(
                co,
                name +
                    " does not take " +
                    n +
                    (n === 1 ? " argument" : " arguments")
            );

        if (numbers) {
            var computed = lua.builtins.compute(name, numbers, latex);
            if (computed) {
                pushValue(co, computed.value);
                return 1;
            }
        }
        return value(co, latex);
    }

    /**
     * The latex `latex` as a Lua value: a number, or - inside an action body - a fragment.
     *
     * A body cannot park. It also has no reason to: Desmos evaluates an update's right-hand side
     * itself, during the fire, against the same pre-action state the rest of the body sees. So
     * `b = f(a)` with `a` cold hands Desmos `f\left(a\right)` and is right for the same reason
     * the hand-written action is.
     *
     * What gets here is what has no number behind it. A builtin over numbers Lua already holds
     * never reaches this - callBuiltin computes it - so a fragment always stands for something
     * genuinely unknown rather than for arithmetic put off until the fire.
     *
     * Everything else is asked of the graph, warm helper or not, so that the *next* time round
     * there is a number. A marker is the exception: it is our own name, the graph has never
     * heard of it, and NaN is not an answer worth branching on. See ./actions.js for both
     * spellings.
     */
    function value(co, latex) {
        if (lua.actions && lua.actions.recording()) {
            if (lua.actions.symbolic() || MARKER.test(latex)) {
                lua.actions.pushLatex(co, latex);
                return 1;
            }
        }
        // Speculative inside a probe: the body ran with made-up arguments, so what it composed
        // is worth *warming* but not worth depending on. `f(random())` composes a latex nobody
        // has ever asked for on every run, and filing that as a dependency would re-run the
        // cell every time the new helper answered - for ever.
        return read(co, latex, !!(lua.actions && lua.actions.probing()));
    }

    /**
     * The graph's value for `latex`, blocking the cell until there is one.
     *
     * This is the yield described at the top of the file. lua_yieldk does not return - it
     * throws LUA_YIELD and unwinds - so the `return` below is for form.
     *
     * `speculative` says the latex was composed by a probe rather than asked for outright: warm
     * it, but do not file it as anything at all. See value().
     *
     * A probe's other reads are held aside rather than filed. A probe runs a body that has not
     * been asked to run - the export it produces is usually a marker, which depends on nothing,
     * so a name the body reads is warmed and not depended on. `function a() n = sin(n) end`
     * next to `n = 1` is the case that matters: filed as a dependency, firing `a()` moves `n`,
     * which re-runs the cell, which puts `n` back to 1. Only a body *written down* with the
     * numbers it read depends on them, and exportFunction files those itself.
     */
    function read(co, latex, speculative) {
        if (!speculative) note(latex);

        var e = helper(latex);

        // A symbolic pass wants the name, not what it is worth. Asked for anyway, and the
        // answer thrown away, because the helper is the warming half of the probe: an action
        // that fires later wants this one ready, and a second pass that needs numbers is about
        // to ask for the same thing in earnest. See actions.probeBody.
        if (lua.actions && lua.actions.symbolic()) {
            lua.actions.pushLatex(co, latex);
            return 1;
        }

        if (!e) {
            C.lua_pushnil(co);
            return 1;
        }
        if (e.ready) {
            pushValue(co, e.value);
            return 1;
        }

        // An action body has nothing to park on. Take the latex instead: Desmos evaluates it
        // during the fire against the pre-action state, which is the value the body wanted. The
        // helper has been made either way, so the next fire has a number and can branch on it.
        if (lua.actions && lua.actions.recording()) {
            // A *probe* runs inside the cell's own run, and one that read cold learned nothing
            // worth keeping - it has only just asked. Come back when there is an answer. Each
            // round resolves one layer (`a`, then `f\left(5\right)`), so it settles rather than
            // spins, and by the time anything fires the reads are numbers.
            if (current && lua.actions.probing())
                waitFor(e, current.id, current.gen);
            lua.actions.pushLatex(co, latex);
            return 1;
        }

        if (current && C.lua_isyieldable(co)) {
            e.wake.push({ cell: current, gen: current.gen });
            current.parked = true;
            return C.lua_yieldk(co, 0, 0, null);
        }

        // A JS callback, or table.sort's comparator: nothing to park. Take nil and let the
        // cell be re-run from the top when the value arrives.
        if (current) current.stale = true;
        C.lua_pushnil(co);
        return 1;
    }

    /**
     * File `latex` as something this run looked at.
     *
     * Where it is filed is the whole of it. A cell's own reads are what the cell depends on, and
     * a change to one re-runs it. A *probe's* are held aside: a probe runs a body nobody asked
     * to run, and the export it produces is usually a marker, which depends on nothing. The case
     * that matters is `function a() n = sin(n) end` next to `n = 1` - filed as the cell's, firing
     * `a()` moves `n`, which re-runs the cell, which puts `n` straight back to 1. Only a body
     * *written down* with the numbers it read depends on them, and actions.exportFunction moves
     * them across itself when that is what happened.
     */
    function note(latex) {
        if (!current) return;
        if (lua.actions && lua.actions.probing()) current.probeReads.add(latex);
        else current.reads.add(latex);
    }

    /**
     * Drop the shared globals' copy of whatever `latex` names, both spellings of it: `abcd` and
     * `a_bcd` are the same `a_{bcd}` and either could be what was written.
     */
    function forget(latex) {
        var m = /^([A-Za-z])(?:_\{([A-Za-z0-9]+)\})?$/.exec(latex);
        if (!m) return;
        var names = m[2] ? [m[1] + m[2], m[1] + "_" + m[2]] : [m[1]];

        var co = L;
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        names.forEach(function (name) {
            C.lua_pushnil(co);
            C.lua_setfield(co, -2, to_luastring(name));
        });
        C.lua_pop(co, 1);
    }

    /**
     * Note that `current` is what moved `latex`, so the invalidation that comes back when the
     * evaluator agrees is not read as somebody else's news. One write only: anything after that
     * really is news.
     */
    function wrote(latex) {
        var e = helpers.get(latex);
        if (e && current) e.writer = { id: current.id };
    }

    /**
     * Ask to be re-run when `e` first has a value. Not the same list as `wake`: that one resumes
     * a parked coroutine, and this cell is not parked - it ran to the end with a fragment and
     * wants another go from the top.
     */
    function waitFor(e, id, gen) {
        if (!e || e.ready) return;
        for (var i = 0; i < e.waiting.length; i++)
            if (e.waiting[i].id === id && e.waiting[i].gen === gen) return;
        e.waiting.push({ id: id, gen: gen });
    }

    function helper(latex) {
        var e = helpers.get(latex);
        if (e) {
            e.used = ++clock;
            if (dead(e)) regraft(e);
            return e;
        }
        if (helpers.size >= HELPER_CAP) evict();
        if (helpers.size >= HELPER_CAP) {
            console.warn("desmos: too many Lua reads, not watching " + latex);
            return null;
        }
        if (typeof Calc.HelperExpression !== "function") return null;

        e = {
            h: null,
            ready: false,
            value: undefined,
            wake: [],
            waiting: [],
            writer: null,
            latex: latex,
            used: ++clock,
            // Filled in by modelOf() and valueOf(): the id Desmos filed this helper's model
            // under, and the typed constant its value was last built out of.
            id: null,
            typed: null
        };
        e.take = function () {
            settle(e, valueOf(e));
        };
        // Only cached once it exists. Cached first, a HelperExpression that threw would leave an
        // entry behind that is never ready and never will be - so the next read of that latex
        // finds it, parks on it, and waits for a value nothing is going to report.
        graft(e);
        helpers.set(latex, e);
        return e;
    }

    /** Watch `e`'s latex: one HelperExpression, both of its channels reporting to e.take. */
    function graft(e) {
        e.id = null;
        e.h = Calc.HelperExpression({ latex: e.latex });
        e.h.observe("numericValue", e.take);
        e.h.observe("listValue", e.take);
    }

    /**
     * Has Desmos thrown this helper away? `isActive` is its own word for it, and it goes false
     * when the evaluator is emptied out from under us - a setState, a setBlank, an undo past a
     * graph load. Nothing says so at the time: the proxy keeps the last number it was told and
     * simply never reports again, so a cell that read `a` before the load goes on being right
     * about the graph that is gone.
     *
     * A build without the property answers undefined, which is not false - so the old
     * behaviour, rather than a helper rebuilt on every read.
     */
    function dead(e) {
        return !!e.h && e.h.isActive === false;
    }

    /**
     * Watch the latex again, on a helper Desmos has let go.
     *
     * The *entry* is kept rather than replaced, which is the whole point of doing it this way:
     * a cell parked on this latex is parked on this object, and `value` has to stay too, so the
     * report that follows is read as the change it is. That is what re-runs the cells still
     * holding the old graph's answer - settle() does it on its own, because to it this is a
     * value that moved.
     */
    function regraft(e) {
        release(e.h);
        // A write we were about to hear back about belongs to the graph that is gone, and so
        // does the typed constant the old model was holding.
        e.writer = null;
        e.typed = null;
        graft(e);
    }

    /**
     * Rewatch everything Desmos has let go of. Called on every graph change, because a load is
     * a graph change and nothing else announces one.
     *
     * The sweep is what covers a latex nobody reads again: a cell that has already run is not
     * going to ask for `a` a second time by itself, so waiting for the next read would leave it
     * showing the old graph's numbers until something else happened to disturb it.
     */
    function resync() {
        helpers.forEach(function (e) {
            if (!dead(e)) return;
            try {
                regraft(e);
            } catch (error) {
                console.warn(
                    "desmos: couldn't watch " + e.latex + " again",
                    error
                );
            }
        });
    }

    /**
     * Let go of the oldest helpers nothing is parked on.
     *
     * Desmos has an add for a helper expression and no remove, so the second half of this
     * reaches past the API: the add stores the model in listModel.__helperIdToModel keyed by an
     * id we were never told, so it is found by matching the proxy we were handed. Guarded, and
     * dropping our own reference is most of the win either way - what is left behind is one
     * statement the evaluator keeps recomputing, not a growing pile of observers.
     */
    function evict() {
        var loose = [];
        helpers.forEach(function (e) {
            if (!e.wake.length) loose.push(e);
        });
        loose.sort(function (a, b) {
            return a.used - b.used;
        });

        loose.slice(0, EVICT).forEach(function (e) {
            helpers.delete(e.latex);
            release(e.h);
        });
    }

    /** Let one HelperExpression go: our observers, and Desmos' own reference to its model. */
    function release(h) {
        try {
            if (h && h.unobserveAll) h.unobserveAll();
            var models = Calc.controller.listModel.__helperIdToModel;
            for (var id in models)
                if (models[id] && models[id].proxy === h) {
                    delete models[id];
                    break;
                }
        } catch (error) {
            // Our reference is gone, which is the part that was leaking.
        }
    }

    /**
     * The model behind a helper, which is where everything the two numeric channels cannot
     * carry is written down: `expression_type` says what kind of thing the latex is worth, and
     * `typed_constant_value` holds the value itself.
     *
     * Reaching past the API, the same way evict() does and for the same reason - the add files
     * the model in listModel.__helperIdToModel under an id we were never told, so it is found
     * by matching the proxy we were handed. The id is kept once found; the model under it is
     * looked up again every time, because a re-parse replaces the object.
     */
    function modelOf(e) {
        try {
            var models = Calc.controller.listModel.__helperIdToModel;
            if (e.id !== null) {
                var known = models[e.id];
                return known && known.proxy === e.h ? known : null;
            }
            for (var id in models)
                if (models[id] && models[id].proxy === e.h) {
                    e.id = id;
                    return models[id];
                }
        } catch (error) {
            // A build that moved it: points read as NaN again, and nothing else changes.
        }
        return null;
    }

    /**
     * What a helper is currently worth: a number, a point, or a list - of numbers, of points,
     * of whatever the thing below turns out to be made of.
     *
     * The model has the first word on anything made of **coordinates**, because a point arrives
     * down the list channel as its two numbers and `\left(1,2\right)` is indistinguishable
     * from `\left[1,2\right]` there. Then the two channels, which are right about a number
     * and about a list of numbers and are the cheap answer for both. What is left is everything
     * neither channel can carry - a list of points, a polygon, a list of colours - and that
     * comes off the model too.
     */
    function valueOf(e) {
        var formula = (modelOf(e) || {}).formula;
        var typed = (formula && formula.typed_constant_value) || null;

        // What we last built a value out of. published() compares against it to find the
        // helpers that moved without saying so.
        e.typed = typed;

        if (typed && POINTED[formula.expression_type] === true)
            return shaped(typed.value, true);

        var list = e.h.listValue;
        if (list && typeof list.length === "number")
            return Array.prototype.slice.call(list);

        var number = e.h.numericValue;
        if (typeof number === "number" && !Number.isNaN(number)) return number;

        if (typed) {
            var value = shaped(typed.value, false);
            if (value !== undefined) return value;
        }
        return number;
    }

    /**
     * A value Desmos has written down as numbers, as the Lua one it stands for: numbers stay
     * numbers, an array becomes a list, and all the way down.
     *
     * `pointed` says the numbers in this value are coordinates, so the innermost run of them is
     * a point - which is what makes a polygon a list of points and a list of points a list of
     * points, off the same two lines. Undefined for anything that is not numbers and arrays at
     * all: an action is the one that reaches here, and it is not a value.
     */
    function shaped(value, pointed) {
        if (typeof value === "number") return value;
        if (!Array.isArray(value)) return undefined;
        if (pointed && value.length && value.every(isNumber))
            return point(value);

        var out = [];
        for (var i = 0; i < value.length; i++) {
            var one = shaped(value[i], pointed);
            if (one === undefined) return undefined;
            out.push(one);
        }
        return out;
    }

    function isNumber(v) {
        return typeof v === "number";
    }

    /** `[1, 2]` -> `{ x = 1, y = 2 }`, which is the point toDesmos already knows how to write. */
    function point(coordinates) {
        var out = {};
        for (var i = 0; i < COORDS.length && i < coordinates.length; i++)
            out[COORDS[i]] = coordinates[i];
        return out;
    }

    /**
     * The graph has been recomputed: re-read every helper whose value moved without the proxy
     * saying so.
     *
     * A HelperExpression only notifies when `numericValue` or `listValue` moves, so for
     * everything they cannot carry the first report is the only one it will ever make - the
     * graph could move a polygon afterwards and no cell that read it would hear about it.
     * Desmos rebuilds `typed_constant_value` whenever the evaluator publishes for an item, so
     * its identity is the cheap test for "this one has been recomputed"; settle() still has the
     * last word on whether the value actually differs.
     */
    function published() {
        pending = false;
        helpers.forEach(function (e) {
            var formula = (modelOf(e) || {}).formula;
            var typed = (formula && formula.typed_constant_value) || null;
            if (typed !== e.typed) e.take();
        });
    }

    /**
     * published(), once this dispatch is over.
     *
     * A subscriber runs *inside* the dispatch, and settling a helper resumes whatever cell was
     * parked on it - so reading the graph here would run Lua in the middle of one, and the
     * first export it made would dispatch inside a dispatch. Desmos queues its own helper
     * notifications rather than making them on the spot for exactly that reason, and this is
     * the same queue.
     *
     * Coalesced, because one recompute is several subscription calls.
     */
    function recheck() {
        if (pending) return;
        pending = true;

        try {
            if (typeof Calc.controller.runAfterDispatch === "function") {
                Calc.controller.runAfterDispatch(published);
                return;
            }
        } catch (error) {
            // A build that moved it; a microtask is out of the dispatch too, just later.
        }
        Promise.resolve().then(published);
    }

    /**
     * Ask to be told when the graph is recomputed.
     *
     * Not the `change` event ./index.js watches: Desmos decides deliberately that an evaluator
     * result is not a change (see nJ in the bundle), and an evaluator result is exactly when a
     * value moves - a slider dragged, a ticker running, an action fired. `subscribeToChanges`
     * is the controller's own subscription and fires for all of it, with the models already
     * rebuilt by the time it runs.
     */
    function listen() {
        if (listening) return;
        try {
            if (typeof Calc.controller.subscribeToChanges !== "function")
                return;
            Calc.controller.subscribeToChanges(recheck);
            listening = true;
        } catch (error) {
            // A build that moved it. Everything still reads right the first time; what is lost
            // is the re-read, so a polygon that moves goes unnoticed until something else asks.
        }
    }

    /**
     * A helper has reported. The first report wakes whatever is parked on it; a later one that
     * actually differs re-runs everything that read it.
     */
    function settle(e, value) {
        var first = !e.ready;
        if (!first && same(e.value, value)) return;

        e.ready = true;
        e.value = value;

        var wake = e.wake.splice(0);
        if (wake.length && lua.bridge.onWake)
            wake.forEach(function (parked) {
                // The generation says which run parked here. A cell that has been re-run
                // since is on a different thread, and this value is not its to take.
                lua.bridge.onWake(parked.cell, value, parked.gen);
            });

        // A probe that read this cold asked to come back; this is the answer it waited for.
        // Only on the first value - after that a change is an invalidation, which re-runs the
        // same cells by the ordinary route.
        var again = e.waiting.splice(0);
        if (first && again.length && lua.bridge.onSettle)
            again.forEach(function (waiting) {
                lua.bridge.onSettle(waiting.id, waiting.gen);
            });

        // The graph has moved this name, so a cell's copy of it is out of date. Dropping it is
        // what puts the graph back in charge of a name a cell once assigned; the copy only ever
        // existed so the rest of *that* run could read what it had just set.
        if (!first) forget(e.latex);

        // One write, one suppressed invalidation - and only when there is one to suppress.
        // Clearing this on a report that does not invalidate (the first, or one the evaluator
        // has not caught up to) would spend the guard on nothing and let the real change come
        // back as somebody else's news, which is the cell re-running on its own write.
        if (!first && lua.bridge.onInvalidate) {
            var writer = e.writer;
            e.writer = null;
            lua.bridge.onInvalidate(e.latex, writer);
        }
    }

    function same(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++)
                if (!same(a[i], b[i])) return false;
            return true;
        }
        // A point, `{ x, y }` - compared coordinate by coordinate for the same reason a list is.
        if (isPoint(a) && isPoint(b))
            return COORDS.every(function (axis) {
                return same(a[axis], b[axis]);
            });
        // NaN is the ordinary state of an undefined name, so it has to compare equal to
        // itself here or every frame would look like a change.
        if (typeof a === "number" && typeof b === "number")
            return a === b || (Number.isNaN(a) && Number.isNaN(b));
        return a === b;
    }

    /** One of point()'s tables, rather than a list or a number. */
    function isPoint(v) {
        return !!v && typeof v === "object" && typeof v.x === "number";
    }

    /** A JS value onto a Lua stack. Numbers, points, lists of either, and nothing else yet. */
    function pushValue(co, v) {
        if (typeof v === "number") {
            C.lua_pushnumber(co, v);
            return;
        }
        // A point is `{ x = 1, y = 2 }`, which is the spelling toDesmos reads back.
        if (isPoint(v)) {
            C.lua_createtable(co, 0, COORDS.length);
            COORDS.forEach(function (axis) {
                if (typeof v[axis] !== "number") return;
                C.lua_pushnumber(co, v[axis]);
                C.lua_setfield(co, -2, to_luastring(axis));
            });
            return;
        }
        if (Array.isArray(v)) {
            C.lua_createtable(co, v.length, 0);
            for (var i = 0; i < v.length; i++) {
                pushValue(co, v[i]);
                C.lua_rawseti(co, -2, i + 1);
            }
            return;
        }
        if (typeof v === "boolean") {
            C.lua_pushboolean(co, v);
            return;
        }
        if (typeof v === "string") {
            C.lua_pushstring(co, to_luastring(v));
            return;
        }
        C.lua_pushnil(co);
    }

    /** `a` -> `a`, `abcd` and `a_bcd` -> `a_{bcd}`, anything else -> null. */
    function toLatex(name) {
        var m = NAME.exec(name);
        if (!m) return null;
        return m[2] ? m[1] + "_{" + m[2] + "}" : m[1];
    }

    /** The other way, for the editor's completion list: `a_{bcd}` -> `abcd`. */
    function toName(latex) {
        var m = /^([A-Za-z])(?:_\{([A-Za-z0-9]+)\})?$/.exec(latex);
        if (!m) return null;
        return m[2] ? m[1] + m[2] : m[1];
    }

    // -----------------------------------------------------------------------
    // calling a function the graph defines
    // -----------------------------------------------------------------------

    /** A Lua function standing for a Desmos one. The latex rides along as its upvalue. */
    function pushCall(co, latex) {
        C.lua_pushstring(co, to_luastring(latex));
        C.lua_pushcclosure(co, callFn, 1);
    }

    /**
     * `f(3)` -> the value of `f\left(3\right)`, by the same park-and-resume a plain read uses:
     * yielding out of a C function with no continuation lets luaD_poscall make the resumed value
     * its result, which is what Desmos.get has always relied on.
     *
     * Each distinct argument is its own latex, its own helper and its own trip to the evaluator,
     * so a Lua loop over a hundred values costs a hundred of them. Desmos functions take lists,
     * and a Lua list becomes one - so `f({1, 2, 3})` is a single trip that comes back a list.
     * That is the way to do it in bulk.
     */
    function callFn(co) {
        var base = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        var n = C.lua_gettop(co);

        // No arguments is a call, not a mistake: `a\\left(\\right)=1` is a function of none, and
        // `a()` is how both Desmos and Lua spell calling it.
        var parts = [];
        for (var i = 1; i <= n; i++) {
            var arg = toDesmos(co, i);
            if (arg.error)
                return fail(
                    co,
                    "cannot pass that to " + base + ": " + arg.error
                );
            parts.push(arg.latex);
        }
        return value(co, base + "\\left(" + parts.join(",") + "\\right)");
    }

    // -----------------------------------------------------------------------
    // writes
    // -----------------------------------------------------------------------

    /**
     * __newindex, for both a cell's environment and _G: the value goes into the shared globals,
     * and onto the graph if it has a Desmos spelling.
     *
     * Best effort, on purpose. `function f(x) ... end` is a global write, and a function is the
     * one thing Desmos cannot be handed - erroring here would take cross-cell functions with
     * it. A value that cannot be expressed is stored and not exported; `Desmos.k = v` below is
     * the door for saying so out loud.
     */
    function envNewIndex(co) {
        var name =
            C.lua_type(co, 2) === C.LUA_TSTRING
                ? C.lua_tojsstring(co, 2)
                : null;
        var latex = name === null ? null : toLatex(name);

        // Inside an action body a Desmos name is not a global at all - it is the target of an
        // update, and the graph is where it lives. Writing it to the shared store too would
        // leave the assignment behind as a global that shadows the graph on the next read.
        if (latex !== null && lua.actions && lua.actions.recording())
            return lua.actions.write(co, latex, 3) ? 0 : 0;

        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_pushvalue(co, 2);
        C.lua_pushvalue(co, 3);
        C.lua_rawset(co, -3);
        C.lua_pop(co, 1);

        if (name === null) return 0;

        if (latex !== null && current) put(co, latex, 3, false);

        // `current` and not the name's readers: a cell that writes what it reads would otherwise
        // invalidate itself every run and spin until the loop guard stopped it.
        if (lua.bridge.onInvalidate)
            lua.bridge.onInvalidate("_:" + name, current);
        return 0;
    }

    /**
     * `latex = <the value at idx>`, from a cell body rather than from inside an action.
     *
     * Three outcomes, and which one it is depends on who owns the name:
     *
     *   - a **function** is an action. It is exported under this name, and running it is Desmos'
     *     to ask for - a button, a ticker, or another cell calling it.
     *   - a name a graph **item** defines is Desmos'. The value is handed over as an update, the
     *     way an action would, so `a = 5` moves the `a=2` that is already there instead of
     *     colliding with it.
     *   - anything else is **ours**: it is published as a statement, which is the definition
     *     appearing if it was missing, and the value being replaced if it was not.
     *
     * `strict` is the difference between `k = v` and `Desmos.k = v`: the first stores a value
     * with no Desmos spelling and says nothing, because `function f() end` is a global write and
     * erroring on it would take cross-cell functions with it; the second asks for the graph
     * outright, so it says so.
     */
    function put(co, latex, idx, strict) {
        if (C.lua_type(co, idx) === C.LUA_TFUNCTION)
            return lua.actions
                ? lua.actions.export(co, current, latex, idx)
                : false;

        if (C.lua_isnil(co, idx)) {
            current.exports.delete(key(latex));
            if (lua.actions) lua.actions.release(current, latex);
            return true;
        }

        var rhs = toDesmos(co, idx);
        if (rhs.error) {
            if (strict)
                return fail(co, 'cannot export "' + latex + '": ' + rhs.error);
            current.exports.delete(key(latex));
            return false;
        }

        if (lua.defining(latex) && lua.actions) {
            // The cell's own doing, so the change it causes is not news to it. Without this a
            // cell that writes a name it also reads - `a = sin(a)` - re-runs on its own write
            // and keeps applying itself until SPIN calls it a loop. runner.invalidate already
            // skips the writer for a Lua-owned name; this is the same rule for a name an
            // expression defines, where the change comes back through the helper instead.
            wrote(latex);
            lua.actions.apply(latex, rhs.latex);
            return true;
        }

        current.exports.set(key(latex), {
            latex: latex + "=" + rhs.latex,
            plot: false
        });
        return true;
    }

    /** The `Desmos` table itself: reads like a global, writes reach the graph. */
    function buildDesmos(co) {
        C.lua_createtable(co, 0, 8);

        C.lua_pushcfunction(co, desmosGet);
        C.lua_setfield(co, -2, to_luastring("get"));
        C.lua_pushcfunction(co, desmosDefine);
        C.lua_setfield(co, -2, to_luastring("define"));
        C.lua_pushcfunction(co, desmosSample);
        C.lua_setfield(co, -2, to_luastring("sample"));

        // The graph itself, as objects. A value has no colour and a number cannot carry a
        // metatable, so an item is a second thing to reach for - and so are the graph's
        // settings and its ticker, which are not values at all. See ./items.js.
        if (lua.items) {
            lua.items.push(co);
            C.lua_setfield(co, -2, to_luastring("items"));
            lua.items.pushSettings(co);
            C.lua_setfield(co, -2, to_luastring("settings"));
            lua.items.pushTicker(co);
            C.lua_setfield(co, -2, to_luastring("ticker"));
        }

        C.lua_createtable(co, 0, 3);
        C.lua_pushcfunction(co, envIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, desmosNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));
        C.lua_setmetatable(co, -2);
    }

    /** Desmos.get("\\sin(2)") - any latex, not just a name. The escape hatch. */
    function desmosGet(co) {
        var latex = C.lua_tojsstring(co, 1);
        if (!latex) {
            C.lua_pushnil(co);
            return 1;
        }
        return value(co, latex);
    }

    /** Desmos.define("g(x)", "x^{2}+1") - Lua writing latex, which is what it is good at. */
    function desmosDefine(co) {
        var lhs = C.lua_tojsstring(co, 1);
        var rhs = C.lua_tojsstring(co, 2);
        if (!lhs || !rhs)
            return fail(co, "Desmos.define needs a left and a right side");
        if (!current) return 0;
        current.exports.set(key(lhs), {
            latex: lhs + "=" + rhs,
            plot: C.lua_isnil(co, 3) ? false : !!C.lua_toboolean(co, 3)
        });
        return 0;
    }

    /**
     * Desmos.sample(name, f, from, to, n) - a Lua function as a table Desmos can plot. It is
     * sampling, not compiling: N points, straight lines between them, and no derivative. That
     * is the honest shape of a Lua function on a Desmos graph, and it is usually enough.
     */
    function desmosSample(co) {
        var name = C.lua_tojsstring(co, 1);
        var from = C.lua_tonumber(co, 3);
        var to = C.lua_tonumber(co, 4);
        var n = C.lua_isnil(co, 5) ? 200 : Math.floor(C.lua_tonumber(co, 5));

        var base = toLatex(name || "");
        if (base === null) return fail(co, "Desmos.sample needs a name");
        if (!isFinite(from) || !isFinite(to))
            return fail(co, "Desmos.sample needs a range");
        if (!(n > 1) || n > 10000)
            return fail(co, "Desmos.sample needs 2..10000 points");
        if (!current) return 0;

        var xs = [];
        var ys = [];
        for (var i = 0; i < n; i++) {
            var x = from + ((to - from) * i) / (n - 1);
            C.lua_pushvalue(co, 2);
            C.lua_pushnumber(co, x);
            // A plain call: sampling must not yield, or the sample loop would have to be a
            // coroutine of its own. A helper read inside `f` takes the stale path instead.
            if (C.lua_pcall(co, 1, 1, 0) !== C.LUA_OK) {
                var why = C.lua_tojsstring(co, -1);
                C.lua_pop(co, 1);
                return fail(co, "Desmos.sample: " + why);
            }
            var y = C.lua_tonumber(co, -1);
            C.lua_pop(co, 1);
            xs.push(x);
            ys.push(y);
        }

        var xn = base + "_{x}";
        var yn = base + "_{y}";
        current.exports.set(key(xn), {
            latex: xn + "=" + list(xs),
            plot: false
        });
        current.exports.set(key(yn), {
            latex: yn + "=" + list(ys),
            plot: false
        });
        // The one that is meant to be seen.
        current.exports.set(key(base), {
            latex: "\\left(" + xn + "," + yn + "\\right)",
            plot: true
        });
        return 0;
    }

    /** Desmos.k = v. Strict where a plain global write is forgiving; see envNewIndex. */
    function desmosNewIndex(co) {
        if (C.lua_type(co, 2) !== C.LUA_TSTRING)
            return fail(co, "a Desmos name has to be a string");
        var name = C.lua_tojsstring(co, 2);
        var latex = toLatex(name);
        if (latex === null)
            return fail(
                co,
                'cannot export "' +
                    name +
                    '": a Desmos name is a letter and an optional subscript, like k or a1'
            );
        if (lua.actions && lua.actions.recording()) {
            lua.actions.write(co, latex, 3);
            return 0;
        }
        if (!current) return 0;

        put(co, latex, 3, true);
        return 0;
    }

    /**
     * A Lua value at `idx` as a JavaScript one, for a builtin to compute with: a number, or a
     * list of them. Undefined for anything else - a latex fragment above all, which stands for a
     * number nobody here has.
     *
     * Deliberately narrower than toDesmos: a point and a list of points have a latex spelling
     * but no arithmetic in this file, and undefined sends them back to it.
     */
    function toJS(co, idx) {
        if (lua.actions && lua.actions.isLatex(co, idx)) return undefined;

        var t = C.lua_type(co, idx);
        if (t === C.LUA_TNUMBER) return C.lua_tonumber(co, idx);
        if (t !== C.LUA_TTABLE) return undefined;

        var n = C.lua_rawlen(co, idx);
        if (!n) return undefined;

        var out = [];
        for (var i = 1; i <= n; i++) {
            C.lua_rawgeti(co, idx, i);
            var number = C.lua_type(co, -1) === C.LUA_TNUMBER;
            if (number) out.push(C.lua_tonumber(co, -1));
            C.lua_pop(co, 1);
            if (!number) return undefined;
        }
        return out;
    }

    /** A Lua value at `idx` as the right-hand side of an expression. */
    function toDesmos(co, idx) {
        var t = C.lua_type(co, idx);

        // A fragment from inside an action body is already the answer.
        if (lua.actions && lua.actions.isLatex(co, idx))
            return { latex: lua.actions.latexOf(co, idx) };

        if (t === C.LUA_TNUMBER) {
            var s = num(C.lua_tonumber(co, idx));
            return s === null ? { error: "it is not a number" } : { latex: s };
        }
        if (t === C.LUA_TBOOLEAN)
            return { latex: C.lua_toboolean(co, idx) ? "1" : "0" };
        if (t === C.LUA_TFUNCTION)
            return {
                error:
                    "a function is an action, not a value. Assign it to a name of its own - " +
                    "`function X(n) ... end` - and use that name where the action goes"
            };
        if (t === C.LUA_TSTRING)
            return {
                error: "a string is not a value. Use Desmos.define(name, latex) for raw latex"
            };
        if (t !== C.LUA_TTABLE) return { error: "it is a " + luaType(co, idx) };

        // A point: `{x = 1, y = 2}`, and `{x, y, z}` in the 3D calculator. The `z` is written
        // down when it is there, so a point read off the graph goes back as the point it was.
        C.lua_getfield(co, idx, to_luastring("x"));
        C.lua_getfield(co, idx, to_luastring("y"));
        C.lua_getfield(co, idx, to_luastring("z"));
        if (
            C.lua_type(co, -3) === C.LUA_TNUMBER &&
            C.lua_type(co, -2) === C.LUA_TNUMBER
        ) {
            var axes = [
                num(C.lua_tonumber(co, -3)),
                num(C.lua_tonumber(co, -2))
            ];
            if (C.lua_type(co, -1) === C.LUA_TNUMBER)
                axes.push(num(C.lua_tonumber(co, -1)));
            C.lua_pop(co, 3);
            if (
                axes.some(function (v) {
                    return v === null;
                })
            )
                return { error: "a point needs numbers for its coordinates" };
            return { latex: "\\left(" + axes.join(",") + "\\right)" };
        }
        C.lua_pop(co, 3);

        // A list. Numbers or points, not a mix and not nested.
        var n = C.lua_rawlen(co, idx);
        var parts = [];
        for (var i = 1; i <= n; i++) {
            C.lua_rawgeti(co, idx, i);
            var inner = C.lua_type(co, -1);
            if (inner === C.LUA_TNUMBER) {
                var v = num(C.lua_tonumber(co, -1));
                C.lua_pop(co, 1);
                if (v === null)
                    return {
                        error: "the list has a value that is not a number"
                    };
                parts.push(v);
            } else if (inner === C.LUA_TTABLE) {
                var point = toDesmos(co, C.lua_absindex(co, -1));
                C.lua_pop(co, 1);
                if (point.error)
                    return { error: "in the list, " + point.error };
                parts.push(point.latex);
            } else {
                C.lua_pop(co, 1);
                return {
                    error:
                        "a list of " +
                        luaType(co, idx) +
                        " has nothing to become"
                };
            }
        }
        if (!parts.length)
            return { error: "an empty table has nothing to become" };
        return { latex: "\\left[" + parts.join(",") + "\\right]" };
    }

    function list(values) {
        return (
            "\\left[" +
            values
                .map(function (v) {
                    return num(v) || "0";
                })
                .join(",") +
            "\\right]"
        );
    }

    /**
     * A number as latex. Not String(v): JavaScript writes 1e-7, which Desmos will not parse.
     */
    function num(v) {
        if (typeof v !== "number" || Number.isNaN(v)) return null;
        if (!Number.isFinite(v)) return v > 0 ? "\\infty" : "-\\infty";
        var s = String(v);
        if (s.indexOf("e") === -1) return s;
        var parts = s.split("e");
        return parts[0] + "\\cdot10^{" + Number(parts[1]) + "}";
    }

    /**
     * The error value on top of `co`, as something worth reading. Does not pop it.
     *
     * `lua_tojsstring` answers null for anything that is not already a string or a number, and
     * the usual way round that - `luaL_tolstring`, which honours `__tostring` - cannot always be
     * used: after a failed resume the thread is dead, and anything that touches its stack
     * asserts. So there are four attempts, narrowing as they go.
     *
     * The third is the one that matters. A JS exception thrown out of one of this extension's own
     * C functions is caught by fengari and handed back as a userdata wrapping the exception - a
     * bug in this file, arriving as the single least useful word it could have chosen: "error".
     * Reaching in for the message is worth the two guarded lines.
     */
    function describe(co) {
        var direct = C.lua_tojsstring(co, -1);
        if (direct) return direct;

        // Honours __tostring, and says "table: 0x22" for a plain one. On a dead thread it
        // asserts - sometimes after pushing - so the stack is put back by height rather than by
        // counting pops, or a half-finished attempt would leave its own string behind for the
        // type check at the bottom to report instead of the error.
        var top = C.lua_gettop(co);
        try {
            var text = F.to_jsstring(lauxlib.luaL_tolstring(co, -1));
            if (text) return text;
        } catch (error) {
            // Dead thread. The two narrower answers below need nothing from its stack.
        } finally {
            C.lua_settop(co, top);
        }

        var thrown = jsError(co);
        if (thrown) return "internal: " + thrown;

        var type = C.lua_type(co, -1);
        if (type === C.LUA_TNIL) return "error(nil)";
        return "error(" + F.to_jsstring(C.lua_typename(co, type)) + ")";
    }

    /** The JS exception fengari wrapped, if that is what this error is. */
    function jsError(co) {
        try {
            var held = C.lua_topointer(co, -1);
            var inner = held && held.data;
            if (inner && inner.data) inner = inner.data;
            if (!inner) return null;
            if (typeof inner.message === "string" && inner.message)
                return (inner.name ? inner.name + ": " : "") + inner.message;
            return null;
        } catch (error) {
            return null;
        }
    }

    function luaType(co, idx) {
        return F.to_jsstring(C.lua_typename(co, C.lua_type(co, idx)));
    }

    function key(latex) {
        return latex.replace(/[^A-Za-z0-9]/g, "");
    }

    function fail(co, message) {
        return lauxlib.luaL_error(co, to_luastring(message));
    }

    // -----------------------------------------------------------------------
    // running a cell, from this side
    // -----------------------------------------------------------------------

    function begin(cell) {
        current = cell;
    }

    function finish() {
        current = null;
    }

    /** print() and warn(), straight to the console. The row has nowhere to show them. */
    function luaPrint(co) {
        return say(co, "log");
    }

    function luaWarn(co) {
        return say(co, "warn");
    }

    function say(co, level) {
        var n = C.lua_gettop(co);
        var parts = [];
        for (var i = 1; i <= n; i++) {
            C.lua_pushvalue(co, i);
            parts.push(F.to_jsstring(lauxlib.luaL_tolstring(co, -1)));
            C.lua_pop(co, 2);
        }
        // Looked up now rather than captured, so a console someone has replaced is still used.
        (console[level] || console.log).call(console, "lua:", parts.join("\t"));
        return 0;
    }

    /**
     * Every name a cell could read, as Lua spells it, for the editor's completion list. The
     * index behind it is the same one reads go through, so the two cannot disagree.
     */
    function names() {
        var found = [];
        defs.forEach(function (kind, latex) {
            var name = toName(latex);
            if (name) found.push(name);
        });
        return found;
    }
})();
