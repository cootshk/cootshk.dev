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
// A cell reaches the graph and nothing else. What it is handed is a list written down in
// pushSafe() below - `math`, `string`, `table`, the safe half of the base library, and `Desmos`
// - and the list is the whole of it: fengari's `js` is never granted, so there is no route from
// a cell to the DOM, to `fetch`, or to anything else on this origin. A graph is somebody else's
// code, and opening one runs it.
//
// The objects this file hands over are closed rather than withheld. Each is a **userdata**
// wearing a `__metatable`, which is Lua's own lock: `setmetatable` refuses one outright and
// `getmetatable` hands back that field instead of the real table - so a cell gets both
// functions, as ordinary Lua, and still cannot reach what is behind them. See pushSealed.
// Userdata rather than a table because `rawget` and `rawset` are granted too, and on a table
// those reach straight past the metamethods: a raw field would sit in front of the very hook
// that reads the graph, for as long as the page lasted.
//
// What the graph answers with keeps its shape. A number is a Lua number - arithmetic, `<`,
// `math.floor` and `string.format` all have to keep working - and everything else is one of
// those objects, remembering the latex it was read from and Desmos' own word for what that
// latex is worth. `__index`, `__len` and `__pairs` mean a list still behaves like one, `__call`
// means a function and an action still spell `f(3)`, and `Desmos.type` is what reports the
// word: "polygon" where Lua would only ever have managed "userdata". A shape goes back to the
// graph as its latex, because written out as the points it reads as it would stop being one.
// See pushObject and SHAPED.
//
// Every cell shares one set of globals and keeps its own locals. The globals live in a table of
// their own, and both `_G` and a cell's own environment are empty tables in front of it wearing
// the same __index/__newindex - so a write is seen by the next cell to read, and a read is
// recorded as a dependency even when an earlier cell put the value there. A metatable on a table
// that also *holds* the values could not do that: a rawget hit never reaches __index.
//
// Which is why the standard library is one shared table too, and why __index falls back to it.
// A cell's environment is seeded with a copy so the chunk's own `print` is a rawget, but `_G`
// holds nothing at all - so without that fallback `_G.print` was nil where `print` was a
// function, and `_G` was an empty table pretending to be the globals. __pairs is the same story
// for walking it: there is nothing to traverse, so a snapshot is built instead.
//
// Writing exports. `a = 2` puts 2 in the globals and `a=2` on the graph, and so does
// `_G.a = 2` and `Desmos.a = 2`. A value that has no Desmos spelling - a function, a string, a
// table of neither points nor numbers - is stored and not exported, silently, because
// `function f(x) ... end` is a global write and cross-cell functions are the point of sharing
// globals at all. `Desmos.k = v` is the strict door: it errors rather than skipping, because it
// asks for the graph outright instead of as a side effect of not writing `local`.
//
// And `rawset(_G, "a", 1)` is the quiet one. It puts a global where every cell reads it and
// nowhere near the graph, so an `a=2` on the sheet keeps its value - `a` is 1 and `Desmos.a` is
// 2, which is the two namespaces saying different things on purpose. A name put there that way
// stays Lua's: assigning it afterwards, by either spelling, no longer reaches the graph either.
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
    var SAFE = "cde.lua.safe";
    var SEALED = "cde.lua.sealed";

    /** The one metatable every value the graph answers with wears. See pushObject. */
    var VALUE_META = "cde.lua.value";

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

    /**
     * The types that are *more* than the numbers they read as.
     *
     * A polygon reads as a list of points, and `\left[\left(1,2\right),\left(3,4\right)\right]`
     * written back is a list of points - a different thing that happens to be drawn in the same
     * place, with no fill and no edges. So one of these goes back to the graph as the latex it
     * was read from, which keeps it what it is.
     *
     * Nothing else does. A point *is* `\left(1,2\right)` and a list of numbers *is*
     * `\left[1,4,9\right]`, so writing those out loses nothing - and a snapshot is what the
     * cell asked for: `Desmos.k = f(3)` is 9 whether or not `f` moves afterwards, and
     * `Desmos.k = f({1,2,3})` has to mean the same thing one row down.
     */
    var SHAPED = {};
    "POLYGON VECTOR2D VECTOR3D SEGMENT3D TRIANGLE3D"
        .split(" ")
        .forEach(function (name) {
            SHAPED[name] = true;
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

        /** What a settled helper is worth, as Lua sees it. runner.js resumes a park with it. */
        pushRead: pushRead,

        /** A list the graph answered with, as numbers. items.js takes one where a table goes. */
        listOf: listOf,

        begin: begin,
        finish: finish,
        names: names,
        defs: defs,

        /** ./index.js calls this on every graph change; see resync(). */
        resync: resync,

        /** Why something failed, in words. runner.js and actions.js both report errors. */
        describe: describe,

        /**
         * The table `getmetatable` hands back for anything of ours. items.js and actions.js
         * lock their own metatables with it, so every object this extension makes answers the
         * same way.
         */
        sealed: pushSealed,

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

        // And the standard library, which every cell is seeded from and every `_G` lookup falls
        // back to. Built on first use, for the same reason the two above are: `Desmos` and
        // `action` want ./items.js and ./actions.js to have registered themselves first.
        C.lua_pushnil(L);
        C.lua_setfield(L, C.LUA_REGISTRYINDEX, to_luastring(SAFE));
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
     * One table per chunk rather than _G itself, so the standard library is a rawget and a cell
     * that shadows one of those names - `print = 1` - has shadowed its own copy rather than
     * everyone's. Everything else about the table is shared, because everything else goes
     * through the metatable.
     *
     * The order here matters. Everything seeded goes in *before* the metatable does, so it lands
     * in this table and nowhere else. Setting any of it afterwards would go through __newindex
     * into the shared globals instead, publishing the standard library to every cell on the
     * graph and spinning the writing cell against its own write until the loop guard stopped it.
     */
    function pushEnv(co) {
        C.lua_createtable(co, 0, 16);
        seed(co);

        pushMeta(co);
        C.lua_setmetatable(co, -2);
    }

    /**
     * What `getmetatable` hands back for anything this extension made: an item, `Desmos`, `_G`,
     * a cell's own environment, a latex fragment, an action.
     *
     * `__metatable` is Lua's own lock - a table that has one cannot be handed to `setmetatable`
     * at all, and `getmetatable` returns this instead of the real thing. So the real metatable
     * is never in a cell's hands, and the closures behind an item's properties stay where they
     * are. It used to be the string `"lua"`, which locked just as well but read as a type error
     * the moment anyone treated the result as a metatable.
     *
     * A table, then, and an empty one that refuses to be written to - so `getmetatable(x).__index
     * = f` says what it is rather than silently changing a table nothing consults. It is its own
     * `__metatable` too, so there is no unwrapping it one layer further down.
     */
    function pushSealed(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(SEALED));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 0);

        C.lua_createtable(co, 0, 3);
        C.lua_pushcfunction(co, sealedNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, sealedToString);
        C.lua_setfield(co, -2, to_luastring("__tostring"));
        C.lua_pushvalue(co, -2);
        C.lua_setfield(co, -2, to_luastring("__metatable"));

        C.lua_setmetatable(co, -2);

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(SEALED));
    }

    function sealedNewIndex(co) {
        return fail(co, "Attempted to set new field on sealed (Desmos) value");
    }

    function sealedToString(co) {
        C.lua_pushstring(co, to_luastring("locked metatable"));
        return 1;
    }

    /** The metatable behind a cell's environment and behind _G. The same one, deliberately. */
    function pushMeta(co) {
        C.lua_createtable(co, 0, 4);
        C.lua_pushcfunction(co, envIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, envNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, envPairs);
        C.lua_setfield(co, -2, to_luastring("__pairs"));
        // Not readable from Lua, so a cell cannot lift our functions out of it.
        pushSealed(co);
        C.lua_setfield(co, -2, to_luastring("__metatable"));
    }

    /**
     * The standard library a cell starts with. Set before the metatable is on, so none of it is
     * seen by __newindex - see pushEnv.
     *
     * What is left out is left out on purpose. `debug` reaches upvalues and the registry and so
     * escapes any sandbox at all; `load`, `require` and `dofile` build an environment of their
     * own; `io`, `os.execute` and `package` are not this page's to offer. And `js` - fengari's
     * bridge to the page, and so to the DOM, `fetch` and every other global on this origin - is
     * offered to nothing and nobody. A cell reaches Desmos, and that is the whole of it.
     *
     * The `raw*` family is in, and it is the one thing here that can be held wrong end up. A
     * `rawset` into `_G` lands in the empty table in front of the shared globals, where it
     * shadows the store for `_G.x` and is invisible to a bare `x` next door; a `rawset` into
     * `Desmos` replaces a function for every cell on the graph. Neither reaches past Desmos, so
     * neither is the sandbox's business - they are the sharp edge of a sharp tool, and reaching
     * for `rawset` is how you say you wanted one.
     */
    function seed(co) {
        pushSafe(co);

        // Copied in rather than reached through, because the cell's environment is what the
        // chunk's own globals rawget against - and a rawset there is how `print = 1` stays the
        // cell's business instead of going out to everyone. `js` is not in the shared table for
        // the same reason the other way round: it must reach one cell and no other.
        drain(co);
    }

    /**
     * The standard library, as one table every cell is seeded from *and* every `_G` lookup falls
     * back to. One table, because those two have to agree: `_G.print` being nil where `print` is
     * a function made `_G` look like an empty table, which is what it literally is - the values
     * live in the cell's own environment, and a lookup through the metatable never saw them.
     *
     * Built once and kept in the registry. Everything in it is shared between cells on purpose:
     * `math` is `math` everywhere, and a cell that rewrites its own `print` has rewritten the
     * copy in its environment rather than this.
     */
    function pushSafe(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(SAFE));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        var safe = [
            "assert",
            "error",
            "getmetatable",
            "ipairs",
            "next",
            "pairs",
            "pcall",
            "xpcall",
            "rawequal",
            "rawget",
            "rawlen",
            "rawset",
            "select",
            "setmetatable",
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

        C.lua_createtable(co, 0, 24);

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

        C.lua_pushcfunction(co, luaPoint);
        C.lua_setfield(co, -2, to_luastring("point"));

        C.lua_pushcfunction(co, luaPrint);
        C.lua_setfield(co, -2, to_luastring("print"));
        C.lua_pushcfunction(co, luaWarn);
        C.lua_setfield(co, -2, to_luastring("warn"));

        // `action(f)` hands `f` straight back and remembers it: the one way a cell says out loud
        // that a body is meant to change the graph rather than work out a value. See
        // ./actions.js, which is also where the rest of that rule lives.
        if (lua.actions) {
            lua.actions.pushBuiltin(co);
            C.lua_setfield(co, -2, to_luastring("action"));
        }

        pushDesmos(co);
        C.lua_setfield(co, -2, to_luastring("Desmos"));

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(SAFE));
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

    /**
     * `_G`: one table, shared by every cell, and the same metatable a cell's environment wears.
     *
     * What it holds raw is what a cell has *rawset* into it, and that is the whole of the
     * difference between the two ways of writing a global:
     *
     *     b = 1                  -- and `_G.b = 1`: __newindex, so it reaches the graph
     *     rawset(_G, "a", 1)     -- straight into this table, and nowhere near the graph
     *
     * Lua's own rule does the work. __newindex fires only for a key the table does not already
     * hold, so an ordinary `_G.b = 1` goes through it every time - nothing is ever kept here by
     * that path - while a name a cell rawset is present, and assigning it afterwards is a plain
     * write that never reaches the graph either. "Unless a rawset has been used" is not a
     * special case anybody wrote; it is what having the values here means.
     *
     * A read finds them because envIndex looks here first. So `rawset(_G, "a", 1)` in one cell
     * is a bare `a` in the next, and an `a=2` on the sheet keeps its value and its own spelling:
     * `Desmos.a` is 2. See desmosIndex.
     */
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

    /**
     * __pairs, for both a cell's environment and _G.
     *
     * Without it `for k, v in pairs(_G)` finds nothing, because `_G` holds nothing: the values
     * are behind __index, and a rawget-based traversal never reaches a metamethod. So a snapshot
     * is built and Lua's own `next` walks that instead.
     *
     * In the order a lookup would find them, so the snapshot says the same thing indexing does:
     * the standard library, then the shared globals every cell writes to, then what has been
     * rawset into `_G`, then whatever this table holds itself - the seeded copies.
     *
     * **The graph is not in it.** `_G.a` answers for a name the sheet defines, and this does not
     * enumerate one: there is no list of them that is a list of *globals*, and asking for each
     * value is a read that can park the cell half way through a loop. The names are still there
     * to be asked for; what is not offered is discovering them this way.
     */
    function envPairs(co) {
        C.lua_createtable(co, 0, 32);

        pushSafe(co);
        drain(co);

        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        drain(co);

        pushGlobals(co);
        drain(co);

        C.lua_pushvalue(co, 1);
        drain(co);

        // `next` over a plain table, which is what pairs would have returned had this one held
        // anything. Taken from the real globals rather than written here: it is the same
        // function the cell's own `next` is.
        C.lua_rawgeti(co, C.LUA_REGISTRYINDEX, C.LUA_RIDX_GLOBALS);
        C.lua_getfield(co, -1, to_luastring("next"));
        C.lua_remove(co, -2);
        C.lua_insert(co, -2);
        C.lua_pushnil(co);
        return 3;
    }

    /** Copy every pair of the table on top into the one below it, and pop the source. */
    function drain(co) {
        C.lua_pushnil(co);
        while (C.lua_next(co, -2)) {
            // dest, src, key, value -> dest, src, key, key, value
            C.lua_pushvalue(co, -2);
            C.lua_insert(co, -2);
            C.lua_rawset(co, -5);
        }
        C.lua_pop(co, 1);
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
        //
        // Below it, in order: what a cell rawset into `_G`, the shared globals, the standard
        // library, and then the graph. `Desmos.a` skips the first three - see desmosIndex.
        if (name === "Desmos") {
            pushDesmos(co);
            return 1;
        }

        var latex = toLatex(name);
        var kind = latex === null ? undefined : defs.get(latex);

        // What a cell has rawset into `_G`, which beats everything below it: reaching for
        // rawset is reaching past the door that publishes to the graph, and a name put there
        // on purpose should not then be answered by the graph. Raw, and it has to be - `_G`
        // wears this very function as its __index, so a lookup honouring metamethods would ask
        // it about a name it has just said it does not hold, for ever.
        pushGlobals(co);
        C.lua_pushstring(co, to_luastring(name));
        C.lua_rawget(co, -2);
        if (!C.lua_isnil(co, -1)) {
            C.lua_remove(co, -2);
            if (current) current.reads.add("_:" + name);
            return 1;
        }
        C.lua_pop(co, 2);

        // The shared globals. Recorded as a dependency the same way a Desmos name is, so cell 1
        // changing `x` re-runs cell 2.
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(STORE));
        C.lua_pushstring(co, to_luastring(name));
        C.lua_rawget(co, -2);
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

        // The standard library. A cell's own environment holds a copy of this, so the chunk's
        // own `print` is a rawget and never arrives here - this is the path `_G.print` takes,
        // and it has to answer with the same function or `_G` is an empty table pretending to
        // be the globals. Before the graph, so a sheet that defines `t_{ype}` does not take
        // `type` away from `_G` when it never took it from the cell.
        pushSafe(co);
        C.lua_getfield(co, -1, to_luastring(name));
        if (!C.lua_isnil(co, -1)) {
            C.lua_remove(co, -2);
            return 1;
        }
        C.lua_pop(co, 2);

        return fromGraph(co, name);
    }

    /**
     * __index for `Desmos`: the graph, and only the graph.
     *
     * `Desmos.a` is what the sheet says `a` is, even where a cell has a Lua global of the same
     * name - which is the point of having the two spellings. A bare `a` is the Lua global if
     * there is one and the graph's otherwise; `Desmos.a` never asks Lua. So `rawset(_G, "a", 1)`
     * next to `a = 2` on the sheet leaves the sheet alone, and both values are still reachable:
     * `a` is 1, `Desmos.a` is 2.
     *
     * The standard library is not on this path either. `Desmos.` is the graph's namespace, so
     * `Desmos.math` is whatever the sheet calls `m_{ath}` and not Lua's table of that name.
     * `Desmos.get`, `.items`, `.settings` and the rest are real fields of the table and never
     * reach a metamethod at all.
     */
    function desmosIndex(co) {
        if (C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }
        return fromGraph(co, C.lua_tojsstring(co, 2));
    }

    /** What the graph has for `name`: a value to wait for, a function to call, an action, or a
     * Desmos builtin. The tail both __index paths end in. */
    function fromGraph(co, name) {
        var latex = toLatex(name);
        if (latex === null) return builtin(co, name);

        // Which *kind* of thing this name is - a value, a function, an action, nothing at all -
        // is itself something to re-run for, so it is filed whether or not a value is read.
        var kind = defs.get(latex);
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
                // The latex rides along even though nothing was asked of the graph: it is what
                // this value *is*, and handing it back puts the call on the graph rather than
                // the numbers it worked out to.
                pushShaped(co, computed.value, latex, null);
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
            pushRead(co, e);
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
            C.lua_pushstring(co, to_luastring(name));
            C.lua_pushnil(co);
            C.lua_rawset(co, -3);
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
            // under, the typed constant its value was last built out of, and Desmos' own word
            // for what the latex is worth - which is the only place "this is a polygon" exists.
            id: null,
            typed: null,
            dtype: null
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
        // And what Desmos calls it, which no channel carries and nothing else records.
        e.dtype = (formula && formula.expression_type) || null;

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
                lua.bridge.onWake(parked.cell, e, parked.gen);
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

    // -----------------------------------------------------------------------
    // what the graph answers with
    // -----------------------------------------------------------------------

    /**
     * A value the graph answered with, as Lua sees it.
     *
     * A **number is a number.** Everything a Lua number can already do - arithmetic, a
     * comparison, `math.floor`, `string.format` - is the whole reason a cell is worth writing,
     * and no metamethod can give that back to something that is not one.
     *
     * Everything else is a closed **userdata** that remembers two things no Lua value could
     * carry on its own: the latex it was read from, and Desmos' own word for what that latex is
     * worth. Those are what make `Desmos.type(p)` able to say "polygon" where Lua would only
     * ever have said "table", and what let a polygon go back to the graph *as a polygon* rather
     * than as the list of points it happens to read as.
     *
     * Userdata rather than a table for the reason a handle is one: `rawset` and `rawget` reach
     * past a table's metamethods, and `rawset` is a thing a cell is given. `__index`, `__len`
     * and `__pairs` mean a list still indexes, measures and walks like a list, and `__call`
     * means a function and an action still spell `f(3)`.
     */
    function pushObject(co, slot) {
        var u = C.lua_newuserdata(co, 0);
        for (var field in slot) u[field] = slot[field];

        pushValueMeta(co);
        C.lua_setmetatable(co, -2);
    }

    /** The one metatable all of them wear, made on first use and kept in the registry. */
    function pushValueMeta(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(VALUE_META));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 7);
        C.lua_pushcfunction(co, objectIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, objectNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, objectLen);
        C.lua_setfield(co, -2, to_luastring("__len"));
        C.lua_pushcfunction(co, objectPairs);
        C.lua_setfield(co, -2, to_luastring("__pairs"));
        C.lua_pushcfunction(co, objectCall);
        C.lua_setfield(co, -2, to_luastring("__call"));
        C.lua_pushcfunction(co, objectToString);
        C.lua_setfield(co, -2, to_luastring("__tostring"));
        C.lua_pushcfunction(co, objectEq);
        C.lua_setfield(co, -2, to_luastring("__eq"));
        pushSealed(co);
        C.lua_setfield(co, -2, to_luastring("__metatable"));

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(VALUE_META));
    }

    /**
     * The value at `idx` if it is one of ours, and null otherwise.
     *
     * Matched on the metatable rather than on what the userdata holds, so an item handle - also
     * a userdata, also of this extension's - is not mistaken for one.
     */
    function objectOf(co, idx) {
        if (C.lua_type(co, idx) !== C.LUA_TUSERDATA) return null;
        if (!C.lua_getmetatable(co, idx)) return null;
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(VALUE_META));
        var same = C.lua_rawequal(co, -1, -2);
        C.lua_pop(co, 2);
        return same ? C.lua_touserdata(co, idx) : null;
    }

    /**
     * A JS value as the Lua one the graph means by it: a number stays a number, a point and a
     * list become objects. `latex` is what this value *is* on the graph, where there is such a
     * thing, and is what writing it back puts there.
     */
    function pushShaped(co, v, latex, dtype) {
        if (typeof v === "number") {
            C.lua_pushnumber(co, v);
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
        if (v === undefined || v === null) {
            C.lua_pushnil(co);
            return;
        }
        pushObject(co, {
            kind: isPoint(v) ? "point" : "list",
            value: v,
            latex: latex || null,
            dtype: dtype || null
        });
    }

    /** What a settled helper is worth, as Lua sees it. runner.js hands the helper straight on. */
    function pushRead(co, e) {
        pushShaped(co, e.value, e.latex, e.dtype);
    }

    /**
     * `p[1]`, `p.x`. A list indexes by position and a point by axis; an element that is itself
     * a point or a list is an object of its own, with no latex, because there is no latex for
     * "the second vertex" short of writing the index out.
     */
    function objectIndex(co) {
        var slot = objectOf(co, 1);
        if (
            slot &&
            slot.kind === "point" &&
            C.lua_type(co, 2) === C.LUA_TSTRING
        ) {
            var axis = C.lua_tojsstring(co, 2);
            if (typeof slot.value[axis] === "number") {
                C.lua_pushnumber(co, slot.value[axis]);
                return 1;
            }
        }
        if (
            slot &&
            slot.kind === "list" &&
            C.lua_type(co, 2) === C.LUA_TNUMBER
        ) {
            var at = C.lua_tonumber(co, 2);
            if (at === Math.floor(at) && at >= 1 && at <= slot.value.length) {
                pushShaped(co, slot.value[at - 1], null, null);
                return 1;
            }
        }
        C.lua_pushnil(co);
        return 1;
    }

    /** What the graph says is the graph's. A cell changes it by assigning the name, not this. */
    function objectNewIndex(co) {
        return fail(co, "Attempted to add a new property to a Desmos object");
    }

    function objectLen(co) {
        var slot = objectOf(co, 1);
        C.lua_pushinteger(
            co,
            !slot
                ? 0
                : slot.kind === "list"
                  ? slot.value.length
                  : slot.kind === "point"
                    ? COORDS.filter(function (axis) {
                          return typeof slot.value[axis] === "number";
                      }).length
                    : 0
        );
        return 1;
    }

    /**
     * `pairs(p)`: a list by position, a point by axis.
     *
     * An iterator rather than a snapshot, and the same reason `Desmos.items` has one - there is
     * nothing in the userdata for Lua's own `next` to walk.
     */
    function objectPairs(co) {
        C.lua_pushcfunction(co, objectNext);
        C.lua_pushvalue(co, 1);
        C.lua_pushinteger(co, 0);
        return 3;
    }

    function objectNext(co) {
        var slot = objectOf(co, 1);
        if (!slot) {
            C.lua_pushnil(co);
            return 1;
        }

        // A point is walked by axis, so the control Lua hands back is the *name* of the one
        // before - not a position. Read as a number it would be 0 every time round, and the
        // loop would hand out `x` for ever.
        if (slot.kind === "point") {
            var axes = COORDS.filter(function (axis) {
                return typeof slot.value[axis] === "number";
            });

            var was = -1;
            if (C.lua_type(co, 2) === C.LUA_TSTRING) {
                was = axes.indexOf(C.lua_tojsstring(co, 2));
                // A key this point does not have: there is nothing after it.
                if (was === -1) {
                    C.lua_pushnil(co);
                    return 1;
                }
            }

            if (was + 1 >= axes.length) {
                C.lua_pushnil(co);
                return 1;
            }
            C.lua_pushstring(co, to_luastring(axes[was + 1]));
            C.lua_pushnumber(co, slot.value[axes[was + 1]]);
            return 2;
        }

        var at = C.lua_tointeger(co, 2) + 1;
        if (slot.kind !== "list" || at < 1 || at > slot.value.length) {
            C.lua_pushnil(co);
            return 1;
        }
        C.lua_pushinteger(co, at);
        pushShaped(co, slot.value[at - 1], null, null);
        return 2;
    }

    /** `f(3)` and `Y()`: the two kinds that are something to run rather than something to read. */
    function objectCall(co) {
        var slot = objectOf(co, 1);
        if (!slot || slot.kind !== "function")
            return fail(
                co,
                `expected type function, got ${slot?.kind || "nil"}`
            );
        return callFn(co, slot.latex);
    }

    /** The latex it stands for, which is what a cell asked the graph for in the first place. */
    function objectToString(co) {
        var slot = objectOf(co, 1);
        var said =
            slot && slot.latex
                ? slot.latex
                : slot
                  ? spell(slot.value).latex || "a " + slot.kind
                  : "a Desmos value";
        C.lua_pushstring(co, to_luastring(said));
        return 1;
    }

    /** Two of them are equal when they are worth the same, not when they are the same object. */
    function objectEq(co) {
        var a = objectOf(co, 1);
        var b = objectOf(co, 2);
        C.lua_pushboolean(co, !!(a && b && same(a.value, b.value)));
        return 1;
    }

    /**
     * `Desmos.type(v)` - a superset of Lua's own `type`.
     *
     * Everything Lua has a word for keeps that word, so this answers "number", "string",
     * "table", "function", "boolean" and "nil" exactly as `type` does. Only where `type` would
     * have said "userdata" - which is every object this extension hands out, and nothing else -
     * does it say something of its own: what Desmos calls the value, lowercased, so a polygon is
     * "polygon" and a list of points is "point_list".
     *
     * Read with lua_typename rather than by calling Lua's `type`, which *is* the builtin by
     * definition and is reached from under Lua - so a cell that rebinds `type`, as cells do,
     * cannot change what this says.
     */
    function desmosType(co) {
        if (C.lua_gettop(co) < 1) {
            C.lua_pushstring(co, to_luastring("nil"));
            return 1;
        }

        var native = luaType(co, 1);
        if (native !== "userdata") {
            C.lua_pushstring(co, to_luastring(native));
            return 1;
        }

        C.lua_pushstring(co, to_luastring(ours(co, 1)));
        return 1;
    }

    /** What one of this extension's own objects is, in a word. */
    function ours(co, idx) {
        var slot = objectOf(co, idx);
        if (slot) {
            // Desmos' own word wherever there is one: SINGLE_POINT, POINT_LIST, POLYGON,
            // VECTOR2D. Lowercased, and nothing else changed - it is Desmos' vocabulary and not
            // ours to tidy into something that would then disagree with the calculator.
            if (slot.dtype) return String(slot.dtype).toLowerCase();
            return slot.kind;
        }
        if (lua.actions) {
            if (lua.actions.isLatex(co, idx)) return "latex";
            if (lua.actions.isAction(co, idx)) return "action";
        }
        if (lua.items && lua.items.isHandle) {
            var handle = lua.items.isHandle(co, idx);
            if (handle) return handle;
        }
        return "userdata";
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

    /**
     * A JS value as latex, for one of the graph's own that has no latex to go back as - an
     * element taken out of a list. The same spellings toDesmos writes for a Lua table.
     */
    function spell(v) {
        if (typeof v === "number") {
            var written = num(v);
            return written === null
                ? { error: "it is not a number" }
                : { latex: written };
        }
        if (isPoint(v)) {
            var axes = [];
            for (var i = 0; i < COORDS.length; i++) {
                if (typeof v[COORDS[i]] !== "number") break;
                var one = num(v[COORDS[i]]);
                if (one === null)
                    return {
                        error: "a point needs numbers for its coordinates"
                    };
                axes.push(one);
            }
            return axes.length >= 2
                ? { latex: "\\left(" + axes.join(",") + "\\right)" }
                : { error: "a point needs at least two coordinates" };
        }
        if (Array.isArray(v)) {
            var parts = [];
            for (var j = 0; j < v.length; j++) {
                var inner = spell(v[j]);
                if (inner.error)
                    return { error: "in the list, " + inner.error };
                parts.push(inner.latex);
            }
            return { latex: "\\left[" + parts.join(",") + "\\right]" };
        }
        return { error: "there is no Desmos value for that" };
    }

    /** A graph list of numbers at `idx`, or null. items.js takes one where it takes a table. */
    function listOf(co, idx) {
        var object = objectOf(co, idx);
        return object && object.kind === "list" && object.value.every(isNumber)
            ? object.value.slice()
            : null;
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

    /**
     * A Desmos function, as something a cell can call.
     *
     * An object rather than a bare Lua closure, so `Desmos.type(f)` can say "function" about
     * the graph's `f` the same way it says "polygon" about a polygon, and so `tostring(f)` is
     * the name it stands for. `__call` is what makes it still spell `f(3)`.
     */
    function pushCall(co, latex) {
        pushObject(co, { kind: "function", latex: latex });
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
    function callFn(co, base) {
        var n = C.lua_gettop(co);

        // No arguments is a call, not a mistake: `a\\left(\\right)=1` is a function of none, and
        // `a()` is how both Desmos and Lua spell calling it.
        var parts = [];
        for (var i = 2; i <= n; i++) {
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

        // A name a cell has rawset into `_G` is Lua's from then on. `_G.b = 1` is already a
        // plain write once `b` is there - __newindex does not fire for a key the table holds -
        // and a bare `b = 1` has to mean the same thing, or which door the assignment went
        // through would decide whether it reached the graph. The cell's environment never holds
        // a global, so its __newindex always runs, and this is where that rule is put back.
        if (name !== null && shadowed(co, name)) {
            pushGlobals(co);
            C.lua_pushvalue(co, 2);
            C.lua_pushvalue(co, 3);
            C.lua_rawset(co, -3);
            C.lua_pop(co, 1);
            if (lua.bridge.onInvalidate)
                lua.bridge.onInvalidate("_:" + name, current);
            return 0;
        }

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

    /** Has a cell rawset `name` into `_G`? Then the graph is not this assignment's business. */
    function shadowed(co, name) {
        pushGlobals(co);
        C.lua_pushstring(co, to_luastring(name));
        C.lua_rawget(co, -2);
        var has = !C.lua_isnil(co, -1);
        C.lua_pop(co, 2);
        return has;
    }

    /**
     * `latex = <the value at idx>`, from a cell body rather than from inside an action.
     *
     * Three outcomes, and which one it is depends on who owns the name:
     *
     *   - a **function** is written down as a Desmos function, or as an action if the source
     *     said so - `action(...)`, or a body that hands one back. ./actions.js has the rule and
     *     refuses the third case, a function that assigns. Either way it is exported under this
     *     name, and running an action is Desmos' to ask for: a button, a ticker, another cell.
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
                return fail(co, `cannot export latex "${latex}": ${rhs.error}`);
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
        C.lua_pushcfunction(co, desmosType);
        C.lua_setfield(co, -2, to_luastring("type"));

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
        C.lua_pushcfunction(co, desmosIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, desmosNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        pushSealed(co);
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
            return fail(co, "Desmos.define needs both a left and right side");
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
        if (base === null) return fail(co, "Desmos.sample expects a name");
        if (!isFinite(from) || !isFinite(to))
            return fail(co, "Desmos.sample expects a range");
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
            return fail(co, `cannot export "${name}" as a Desmos name.`);
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

        // A list the graph answered with is numbers like any other, so `total(L)` is still
        // arithmetic here rather than a round trip to the worker.
        var object = objectOf(co, idx);
        if (object)
            return object.kind === "list" && object.value.every(isNumber)
                ? object.value.slice()
                : undefined;

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

        // A value the graph answered with. A shape goes back as the latex it was read from,
        // because that is the only spelling that keeps it one - see SHAPED. Everything else is
        // written out, which is both what it is and a snapshot, so a value read once does not
        // quietly follow the thing it was read from afterwards.
        var object = objectOf(co, idx);
        if (object) {
            if (object.kind === "function")
                return {
                    error: "received a function (did you call it?)"
                };
            if (object.latex && SHAPED[object.dtype])
                return { latex: object.latex };
            return spell(object.value);
        }

        if (t === C.LUA_TNUMBER) {
            var s = num(C.lua_tonumber(co, idx));
            return s === null ? { error: "it is not a number" } : { latex: s };
        }
        if (t === C.LUA_TBOOLEAN)
            return { latex: C.lua_toboolean(co, idx) ? "1" : "0" };
        if (t === C.LUA_TFUNCTION)
            return {
                error: "attempted to assign a function. Did you mean to wrap it in action()?"
            };
        if (t === C.LUA_TSTRING)
            return {
                error: "cannot assign a string. Try Desmos.define instead"
            };
        if (t !== C.LUA_TTABLE) return { error: "it is a " + luaType(co, idx) };

        // A point: `{x = 1, y = 2}`, and `{x, y, z}` in the 3D calculator. The `z` is written
        // down when it is there, so a point read off the graph goes back as the point it was.
        //
        // Read raw, the way the list below already is. A cell can set a metatable now, and an
        // `__index` here would be arbitrary Lua running inside a conversion that is called from
        // places Lua must not run - an action fire, a JS callback, a context that cannot yield.
        // What goes to the graph is what the table holds.
        rawfield(co, idx, "x");
        rawfield(co, idx, "y");
        rawfield(co, idx, "z");
        if (isCoord(co, -3) && isCoord(co, -2)) {
            var axes = [coord(co, -3), coord(co, -2)];
            if (isCoord(co, -1)) axes.push(coord(co, -1));
            C.lua_pop(co, 3);
            if (
                axes.some(function (v) {
                    return v === null;
                })
            )
                return { error: "points require numeric coordinates" };
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
                        error: "list contains a non-numeric value"
                    };
                parts.push(v);
            } else if (inner === C.LUA_TTABLE || inner === C.LUA_TUSERDATA) {
                // A table of this cell's own, or a point the graph answered with - `point(1,2)`
                // is the second now, and a list of them is the ordinary way to build a path.
                var point = toDesmos(co, C.lua_absindex(co, -1));
                C.lua_pop(co, 1);
                if (point.error)
                    return { error: "in the list, " + point.error };
                // A list of lists is not a Desmos value. The only table a list may hold is a
                // point, and an empty one is a list - so it is refused here rather than written
                // down as latex Desmos would read as something else entirely.
                if (point.latex.indexOf("\\left(") !== 0)
                    return {
                        error: "list contains another list"
                    };
                parts.push(point.latex);
            } else {
                C.lua_pop(co, 1);
                return {
                    error: `cannot coerce a list of type ${luaType(co, idx)}.`
                };
            }
        }
        // An empty table is an empty list, which is a value Desmos has. A table with keys in
        // it that got this far is not: it held something none of the above knew what to do
        // with, and calling that an empty list would be writing down a value nobody asked for.
        if (!parts.length) {
            if (bare(co, idx)) return { latex: "\\left[\\right]" };
            return {
                error: "table cannot be represented in Desmos"
            };
        }
        return { latex: "\\left[" + parts.join(",") + "\\right]" };
    }

    /**
     * Is the value at `idx` something a coordinate can be made of, and what is it worth?
     *
     * A number, or - inside an action body - a latex fragment, which is how `point(n, 2)` works
     * where `n` is the action's own argument and nobody has a number for it yet. The two are
     * apart from each other so that `{x = "no"}` is a point with a bad coordinate rather than
     * something that falls through to the list below and is reported as neither.
     */
    function isCoord(co, idx) {
        if (C.lua_type(co, idx) === C.LUA_TNUMBER) return true;
        return !!(lua.actions && lua.actions.isLatex(co, idx));
    }

    function coord(co, idx) {
        if (C.lua_type(co, idx) === C.LUA_TNUMBER)
            return num(C.lua_tonumber(co, idx));
        return lua.actions.latexOf(co, idx);
    }

    /** Is this table empty - no array part and no keys at all? */
    function bare(co, idx) {
        var at = C.lua_absindex(co, idx);
        C.lua_pushnil(co);
        if (!C.lua_next(co, at)) return true;
        C.lua_pop(co, 2);
        return false;
    }

    /** `t.name` without metamethods, pushed. `idx` may be relative; it is resolved first. */
    function rawfield(co, idx, name) {
        var at = C.lua_absindex(co, idx);
        C.lua_pushstring(co, to_luastring(name));
        C.lua_rawget(co, at);
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

    /**
     * `point(1, 2)`, which is `\left(1,2\right)` on the graph - and `point(1, 2, 3)` in the 3D
     * calculator.
     *
     * It hands back the same kind of object a point read *off* the graph arrives in, so
     * `point(1, 2).x` is 1, `Desmos.type` says "single_point" about both, and a point can be
     * taken apart and put back together without either end knowing which door it came through.
     * What this adds is the name, the arity check, and saying which coordinate is wrong where
     * one is.
     */
    function luaPoint(co) {
        var n = C.lua_gettop(co);
        if (n !== 2 && n !== 3)
            return fail(co, "point takes 2 or 3 values, got " + n);

        var axes = [];
        var numbers = {};
        var known = true;

        for (var i = 1; i <= n; i++) {
            if (!isCoord(co, i))
                return fail(
                    co,
                    `'expected number for value "${COORDS[i - 1]}", got ${luaType(co, i)}`
                );

            var one = coord(co, i);
            if (one === null)
                return fail(co, `expected real number, got "${COORDS[i - 1]}"`);
            axes.push(one);

            if (C.lua_type(co, i) === C.LUA_TNUMBER)
                numbers[COORDS[i - 1]] = C.lua_tonumber(co, i);
            else known = false;
        }

        var latex = "\\left(" + axes.join(",") + "\\right)";

        // Inside an action body a coordinate can be a name nothing has a number for yet, and a
        // point built out of one is a formula rather than a value - so it is the same fragment
        // every other half-known thing in a body is, and Desmos works it out at fire time.
        if (!known) {
            lua.actions.pushLatex(co, latex);
            return 1;
        }

        pushObject(co, {
            kind: "point",
            value: numbers,
            latex: latex,
            dtype: "SINGLE_POINT"
        });
        return 1;
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
