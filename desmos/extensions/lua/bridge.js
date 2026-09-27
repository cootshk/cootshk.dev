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
// Writing is the dull direction on purpose. `Desmos.k = 5` records an export; a plain global
// write does not. __newindex fires for every new global, so exporting them all would turn a
// forgotten `local` into a definition on someone's graph.
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

    /**
     * A Desmos name, as Lua spells it: one letter, optionally a subscript. `a` is `a`, and
     * `a_b` is `a_{b}`. This is Desmos' own identifier shape, which makes it both the right
     * filter and a cheap one - `myhelper` is never mistaken for something to go asking the
     * evaluator about.
     */
    var NAME = /^([A-Za-z])(?:_([A-Za-z0-9]+))?$/;

    /** latex -> { h, ready, value, wake: [] }. One HelperExpression per name asked for. */
    var helpers = new Map();

    /** Past this many live helpers we stop making new ones rather than leak without bound. */
    var HELPER_CAP = 500;

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

        // The shared cross-cell table. Every cell's `_G` is this one, so a function cell 1
        // defines is a function cell 2 can call.
        C.lua_createtable(L, 0, 0);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(STORE));

        // Somewhere to anchor running threads, so they are not collected mid-yield.
        C.lua_createtable(L, 0, 0);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(THREADS));
    }

    // -----------------------------------------------------------------------
    // the environment a cell runs in
    // -----------------------------------------------------------------------

    /**
     * Push the environment table for a chunk. Empty, with a metatable, so *every* global read
     * and write in the cell comes through us - which is what makes both "cell 2 sees what cell
     * 1 defined" and "cell 2 re-runs when cell 1 changes it" fall out of the same hook.
     *
     * A metatable on the real _G could not do this: a rawget hit never reaches __index, so the
     * second cell to read a name would be invisible.
     */
    function pushEnv(co) {
        C.lua_createtable(co, 0, 16);
        seed(co);

        C.lua_createtable(co, 0, 3);
        C.lua_pushcfunction(co, envIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, envNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        // Not readable from Lua, so a cell cannot lift our functions out of it.
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));
        C.lua_setmetatable(co, -2);
    }

    /**
     * The standard library a cell starts with, raw-set so the metatable never sees it.
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

        // `_G` is the shared store rather than the real globals table: a cell writing _G.x is
        // talking to the other cells, not to the page.
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_setfield(co, -2, to_luastring("_G"));

        C.lua_pushcfunction(co, luaPrint);
        C.lua_setfield(co, -2, to_luastring("print"));

        pushDesmos(co);
        C.lua_setfield(co, -2, to_luastring("Desmos"));
    }

    /** `js`, for a cell whose sentinel line says `unsafe`. */
    function grantJs(co) {
        C.lua_rawgeti(co, C.LUA_REGISTRYINDEX, C.LUA_RIDX_GLOBALS);
        C.lua_getfield(co, -1, to_luastring("js"));
        C.lua_remove(co, -2);
    }

    // -----------------------------------------------------------------------
    // reads
    // -----------------------------------------------------------------------

    /** env.__index: another cell's global, then the graph. */
    function envIndex(co) {
        if (C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }
        var name = C.lua_tojsstring(co, 2);

        // Another cell's global. Recorded as a dependency the same way a Desmos name is, so
        // cell 1 changing `x` re-runs cell 2.
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
        if (e) return e;
        if (helpers.size >= HELPER_CAP) {
            console.warn("desmos: too many Lua reads, not watching " + latex);
            return null;
        }
        if (typeof Calc.HelperExpression !== "function") return null;

        e = { h: null, ready: false, value: undefined, wake: [], latex: latex };
        helpers.set(latex, e);

        e.h = Calc.HelperExpression({ latex: latex });
        var take = function () {
            settle(e, valueOf(e.h));
        };
        e.h.observe("numericValue", take);
        e.h.observe("listValue", take);
        return e;
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

    /** `a` -> `a`, `a_b` -> `a_{b}`, anything else -> null. */
    function toLatex(name) {
        var m = NAME.exec(name);
        if (!m) return null;
        return m[2] ? m[1] + "_{" + m[2] + "}" : m[1];
    }

    // -----------------------------------------------------------------------
    // writes
    // -----------------------------------------------------------------------

    /**
     * env.__newindex: a plain global. Goes into the shared store and invalidates whoever read
     * it - it does *not* become an expression. `function f() end` at the top of a cell is a
     * global write, and a graph full of expressions named `f` would be nobody's idea of help.
     */
    function envNewIndex(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_pushvalue(co, 2);
        C.lua_pushvalue(co, 3);
        C.lua_rawset(co, -3);
        C.lua_pop(co, 1);

        if (C.lua_type(co, 2) === C.LUA_TSTRING && lua.bridge.onInvalidate)
            lua.bridge.onInvalidate("_:" + C.lua_tojsstring(co, 2));
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
        if (base === null)
            return fail(co, "Desmos.sample needs a one-letter name");
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

    /** Desmos.k = v. */
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
                    '": a Desmos name is one letter and an optional subscript, like k or a_1'
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

    /** print() goes to the cell's own output strip, not just the console. */
    function luaPrint(co) {
        var n = C.lua_gettop(co);
        var parts = [];
        for (var i = 1; i <= n; i++) {
            C.lua_pushvalue(co, i);
            parts.push(F.to_jsstring(lauxlib.luaL_tolstring(co, -1)));
            C.lua_pop(co, 2);
        }
        var line = parts.join("\t");
        if (current) current.output.push(line);
        console.log("lua:", line);
        return 0;
    }

    /** Every name currently defined on the graph, for the editor's completion list. */
    function names() {
        var list = (Calc.getState().expressions || {}).list || [];
        var found = [];
        list.forEach(function (item) {
            if (item.type !== "expression" || !item.latex) return;
            var m = /^\s*([A-Za-z])(?:_\{?([A-Za-z0-9]+)\}?)?\s*=/.exec(
                item.latex
            );
            if (m) found.push(m[2] ? m[1] + "_" + m[2] : m[1]);
        });
        return found;
    }

    lua.bridge.grantJs = grantJs;
})();
