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

    /**
     * A Desmos name, as Lua spells it. A Desmos identifier is one letter and an optional
     * subscript, so `a` is `a` and everything after the first letter is the subscript: `abcd`
     * and `a_bcd` both mean `a_{bcd}`. A name that cannot be one - `_x`, `a_`, `x2y` is fine but
     * `1x` is not - is never asked about, which is what keeps `pairs` and `_G` off the graph.
     */
    var NAME = /^([A-Za-z])(?:_?([A-Za-z0-9]+))?$/;

    /** latex -> { h, ready, value, wake: [], used }. One HelperExpression per latex asked for. */
    var helpers = new Map();

    /**
     * Past this many live helpers the oldest unparked ones are let go. Reachable now that a call
     * is keyed by its argument: `f(1)` and `f(2)` are two different latexes to watch.
     */
    var HELPER_CAP = 500;

    /** How many to let go at once, so eviction is not a scan of the whole map per new helper. */
    var EVICT = 64;

    /** Bumped on every read, so the least recently used helper is the one to drop. */
    var clock = 0;

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

        /** runner.js fills these in. */
        onWake: null,
        onInvalidate: null
    };

    function init(calc) {
        Calc = calc;

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

        // The shared globals. Recorded as a dependency the same way a Desmos name is, so cell 1
        // changing `x` re-runs cell 2.
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_getfield(co, -1, to_luastring(name));
        if (!C.lua_isnil(co, -1)) {
            C.lua_remove(co, -2);
            if (current) current.reads.add("_:" + name);
            return 1;
        }
        C.lua_pop(co, 2);

        var latex = toLatex(name);
        if (latex === null) {
            C.lua_pushnil(co);
            return 1;
        }
        if (current) current.reads.add(latex);

        var kind = defs.get(latex);
        if (kind === "function") {
            pushCall(co, latex);
            return 1;
        }
        if (kind === undefined) {
            C.lua_pushnil(co);
            return 1;
        }
        return read(co, latex);
    }

    /**
     * The graph's value for `latex`, blocking the cell until there is one.
     *
     * This is the yield described at the top of the file. lua_yieldk does not return - it
     * throws LUA_YIELD and unwinds - so the `return` below is for form.
     */
    function read(co, latex) {
        if (current) current.reads.add(latex);

        var e = helper(latex);
        if (!e) {
            C.lua_pushnil(co);
            return 1;
        }
        if (e.ready) {
            pushValue(co, e.value);
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

    function helper(latex) {
        var e = helpers.get(latex);
        if (e) {
            e.used = ++clock;
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
            latex: latex,
            used: ++clock
        };
        helpers.set(latex, e);

        e.h = Calc.HelperExpression({ latex: latex });
        var take = function () {
            settle(e, valueOf(e.h));
        };
        e.h.observe("numericValue", take);
        e.h.observe("listValue", take);
        return e;
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
            try {
                if (e.h && e.h.unobserveAll) e.h.unobserveAll();
                var models = Calc.controller.listModel.__helperIdToModel;
                for (var id in models)
                    if (models[id] && models[id].proxy === e.h) {
                        delete models[id];
                        break;
                    }
            } catch (error) {
                // Our reference is gone, which is the part that was leaking.
            }
        });
    }

    /** What a HelperExpression is currently worth: a list if it has one, else a number. */
    function valueOf(h) {
        var list = h.listValue;
        if (list && typeof list.length === "number")
            return Array.prototype.slice.call(list);
        return h.numericValue;
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

        if (!first && lua.bridge.onInvalidate) lua.bridge.onInvalidate(e.latex);
    }

    function same(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++)
                if (!same(a[i], b[i])) return false;
            return true;
        }
        // NaN is the ordinary state of an undefined name, so it has to compare equal to
        // itself here or every frame would look like a change.
        if (typeof a === "number" && typeof b === "number")
            return a === b || (Number.isNaN(a) && Number.isNaN(b));
        return a === b;
    }

    /** A JS value onto a Lua stack. Numbers, lists of numbers, and nothing else yet. */
    function pushValue(co, v) {
        if (typeof v === "number") {
            C.lua_pushnumber(co, v);
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
        if (!n) return fail(co, base + " needs an argument");

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
        return read(co, base + "\\left(" + parts.join(",") + "\\right)");
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

        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_pushvalue(co, 2);
        C.lua_pushvalue(co, 3);
        C.lua_rawset(co, -3);
        C.lua_pop(co, 1);

        if (name === null) return 0;

        var latex = toLatex(name);
        if (latex !== null && current) {
            var rhs = C.lua_isnil(co, 3) ? { error: "nil" } : toDesmos(co, 3);
            if (rhs.error) current.exports.delete(key(latex));
            else
                current.exports.set(key(latex), {
                    latex: latex + "=" + rhs.latex,
                    plot: false
                });
        }

        // `current` and not the name's readers: a cell that writes what it reads would otherwise
        // invalidate itself every run and spin until the loop guard stopped it.
        if (lua.bridge.onInvalidate)
            lua.bridge.onInvalidate("_:" + name, current);
        return 0;
    }

    /** The `Desmos` table: reads like a global, writes become expressions. */
    function pushDesmos(co) {
        C.lua_createtable(co, 0, 8);

        C.lua_pushcfunction(co, desmosGet);
        C.lua_setfield(co, -2, to_luastring("get"));
        C.lua_pushcfunction(co, desmosDefine);
        C.lua_setfield(co, -2, to_luastring("define"));
        C.lua_pushcfunction(co, desmosSample);
        C.lua_setfield(co, -2, to_luastring("sample"));

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
        return read(co, latex);
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
        if (!current) return 0;

        if (C.lua_isnil(co, 3)) {
            current.exports.delete(key(latex));
            return 0;
        }

        var rhs = toDesmos(co, 3);
        if (rhs.error)
            return fail(co, 'cannot export "' + name + '": ' + rhs.error);
        current.exports.set(key(latex), {
            latex: latex + "=" + rhs.latex,
            plot: false
        });
        return 0;
    }

    /** A Lua value at `idx` as the right-hand side of an expression. */
    function toDesmos(co, idx) {
        var t = C.lua_type(co, idx);

        if (t === C.LUA_TNUMBER) {
            var s = num(C.lua_tonumber(co, idx));
            return s === null ? { error: "it is not a number" } : { latex: s };
        }
        if (t === C.LUA_TBOOLEAN)
            return { latex: C.lua_toboolean(co, idx) ? "1" : "0" };
        if (t === C.LUA_TFUNCTION)
            return {
                error:
                    "Desmos has no way to call a Lua function. Use Desmos.define to write " +
                    "the latex yourself, or Desmos.sample to plot it as points"
            };
        if (t === C.LUA_TSTRING)
            return {
                error: "a string is not a value. Use Desmos.define(name, latex) for raw latex"
            };
        if (t !== C.LUA_TTABLE) return { error: "it is a " + luaType(co, idx) };

        // A point, {x = 1, y = 2}.
        C.lua_getfield(co, idx, to_luastring("x"));
        C.lua_getfield(co, idx, to_luastring("y"));
        if (
            C.lua_type(co, -2) === C.LUA_TNUMBER &&
            C.lua_type(co, -1) === C.LUA_TNUMBER
        ) {
            var px = num(C.lua_tonumber(co, -2));
            var py = num(C.lua_tonumber(co, -1));
            C.lua_pop(co, 2);
            if (px === null || py === null)
                return { error: "a point needs two numbers" };
            return { latex: "\\left(" + px + "," + py + "\\right)" };
        }
        C.lua_pop(co, 2);

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
