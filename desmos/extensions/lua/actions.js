// Actions, both ways: a Lua function is one, and a Desmos one is callable from Lua.
//
// A Desmos action is simultaneous. `A = a\to a+1, b\to a` moves `a` and leaves `b` at the *old*
// `a`, because every right-hand side is evaluated against the state before anything moved. That
// is the whole of the semantics here, and everything else follows from it:
//
//   - a body's updates are collected rather than applied, and land in one go at the end;
//   - a target named twice is an error, not a last-write-wins, and it aborts the body so a
//     half-moved graph is not a state anything can observe;
//   - and a read inside a body sees the pre-action value.
//
// Two kinds of value make that last point work. A *number*, when the name is already watched -
// which is what lets Lua branch on it - and otherwise a *latex fragment*, which Desmos evaluates
// during the fire against the same pre-action state. `b = f(sin(a))` is the second kind, and is
// correct for exactly the reason the hand-written action is.
//
// How a Lua body gets to run inside a fire at all: the action a cell exports is a marker,
//
//     X\left(n\right) = \left(L_{ua3}\to n\right)
//
// and ./index.js patches the one line where Desmos applies an action's updates
// (`updateLatexForIdentifier` over `eventUpdates.updates`). Seeing a marker there means "run this
// body now", inside the same fire, so there is no frame of lag and a ticker runs at full speed
// with Lua in the loop. The marker also carries the arguments: one marker variable per parameter,
// so a list argument still works.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    var F = window.fengari;
    var C = F.lua;
    var lauxlib = F.lauxlib;
    var to_luastring = F.to_luastring;

    /** The metatable for a latex fragment, and for a callable action. Kept in the registry. */
    var LATEX_META = "cde.lua.latex";
    var ACTION_META = "cde.lua.action";

    /** marker -> the Lua function it stands for, so a fire can find a body to run. */
    var BODIES = "cde.lua.bodies";

    /** Marker variables are `L_{uaN}`; N counts up and is never reused within a page. */
    var counter = 0;

    /** Normalised marker name -> the slot it belongs to. What a fire is recognised by. */
    var live = new Map();

    /**
     * The recording in progress, or null: `{ updates: Map, probe }`, where `updates` maps a
     * Desmos name to the latex it is to become.
     */
    var recorder = null;

    var Calc = null;

    lua.actions = {
        init: init,

        /** Is a body being recorded right now? bridge.js asks before it reads or writes. */
        recording: function () {
            return !!recorder;
        },

        /** the two Lua value kinds this file adds */
        pushLatex: pushLatex,
        isLatex: isLatex,
        latexOf: latexOf,
        pushAction: pushAction,

        /** bridge.js calls these from __newindex */
        write: write,
        export: exportAction,
        release: release,
        apply: apply,

        /** ./index.js calls these: the patch, and running an action from a cell */
        updates: updates,
        call: call,
        forget: forget
    };

    function init(calc) {
        Calc = calc;
    }

    /** A fresh marker variable name, for one exported action. */
    function marker() {
        return "L_{ua" + counter++ + "}";
    }

    /** An export map key, the same way bridge.js spells one. */
    function key(latex) {
        return latex.replace(/[^A-Za-z0-9]/g, "");
    }

    // -----------------------------------------------------------------------
    // a latex fragment, as a Lua value
    // -----------------------------------------------------------------------

    /**
     * Push a value standing for `latex`, for use inside an action body where there is nothing to
     * park on. Arithmetic on it composes latex; a comparison errors, because that would need a
     * number the fire cannot fetch.
     *
     * A table rather than a userdata: fengari has no lua_newuserdata that carries a JS value
     * usefully, and a table with a locked metatable is just as closed - `__metatable` means a
     * cell cannot reach in and rewrite the latex, and `__index` means it cannot read a field that
     * is not there.
     */
    function pushLatex(co, latex) {
        C.lua_createtable(co, 0, 1);
        C.lua_pushstring(co, to_luastring(String(latex)));
        C.lua_rawseti(co, -2, 1);
        pushLatexMeta(co);
        C.lua_setmetatable(co, -2);
    }

    function pushLatexMeta(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(LATEX_META));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 16);

        // Arithmetic, each one composing latex rather than computing.
        binary(co, "__add", function (a, b) {
            return a + "+" + b;
        });
        binary(co, "__sub", function (a, b) {
            return a + "-\\left(" + b + "\\right)";
        });
        binary(co, "__mul", function (a, b) {
            return "\\left(" + a + "\\right)\\cdot\\left(" + b + "\\right)";
        });
        binary(co, "__div", function (a, b) {
            return "\\frac{" + a + "}{" + b + "}";
        });
        binary(co, "__pow", function (a, b) {
            return "\\left(" + a + "\\right)^{" + b + "}";
        });
        binary(co, "__mod", function (a, b) {
            return "\\operatorname{mod}\\left(" + a + "," + b + "\\right)";
        });
        C.lua_pushcfunction(co, latexUnm);
        C.lua_setfield(co, -2, to_luastring("__unm"));
        C.lua_pushcfunction(co, latexToString);
        C.lua_setfield(co, -2, to_luastring("__tostring"));
        C.lua_pushcfunction(co, latexConcat);
        C.lua_setfield(co, -2, to_luastring("__concat"));

        // A comparison needs a number, and the fire has nowhere to get one.
        ["__lt", "__le", "__eq"].forEach(function (event) {
            C.lua_pushcfunction(co, latexCompare);
            C.lua_setfield(co, -2, to_luastring(event));
        });

        // Closed, like every other metatable here.
        C.lua_pushcfunction(co, latexIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(LATEX_META));
    }

    /** One arithmetic metamethod, closed over how it joins its two sides. */
    function binary(co, event, join) {
        // A JS closure over `join`, so the metamethod needs no Lua upvalue of its own.
        C.lua_pushcfunction(co, function (L2) {
            var a = side(L2, 1);
            var b = side(L2, 2);
            if (a === null || b === null)
                return fail(
                    L2,
                    "cannot do arithmetic between a Desmos value and that"
                );
            pushLatex(L2, join(a, b));
            return 1;
        });
        C.lua_setfield(co, -2, to_luastring(event));
    }

    /** One side of an arithmetic metamethod as latex: a fragment, or a plain number. */
    function side(co, idx) {
        if (isLatex(co, idx)) return latexOf(co, idx);
        if (C.lua_type(co, idx) === C.LUA_TNUMBER)
            return lua.bridge.num(C.lua_tonumber(co, idx));
        return null;
    }

    function latexUnm(co) {
        var a = side(co, 1);
        if (a === null) return fail(co, "cannot negate that");
        pushLatex(co, "-\\left(" + a + "\\right)");
        return 1;
    }

    function latexToString(co) {
        C.lua_pushstring(co, to_luastring(latexOf(co, 1) || "?"));
        return 1;
    }

    function latexConcat(co) {
        var a = isLatex(co, 1)
            ? latexOf(co, 1)
            : F.to_jsstring(lauxlib.luaL_tolstring(co, 1));
        var b = isLatex(co, 2)
            ? latexOf(co, 2)
            : F.to_jsstring(lauxlib.luaL_tolstring(co, 2));
        C.lua_pushstring(co, to_luastring(String(a) + String(b)));
        return 1;
    }

    function latexCompare(co) {
        return fail(
            co,
            "this is a Desmos value, not a number - the graph has not been asked for it yet, " +
                "so it cannot be compared inside an action. Read it in the cell body instead"
        );
    }

    function latexIndex(co) {
        C.lua_pushnil(co);
        return 1;
    }

    /** Is the value at `idx` one of our latex fragments? */
    function isLatex(co, idx) {
        if (C.lua_type(co, idx) !== C.LUA_TTABLE) return false;
        if (!C.lua_getmetatable(co, idx)) return false;
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(LATEX_META));
        var same = C.lua_rawequal(co, -1, -2);
        C.lua_pop(co, 2);
        return !!same;
    }

    function latexOf(co, idx) {
        if (!isLatex(co, idx)) return null;
        C.lua_rawgeti(co, idx, 1);
        var latex = C.lua_tojsstring(co, -1);
        C.lua_pop(co, 1);
        return latex;
    }

    // -----------------------------------------------------------------------
    // a Desmos action, as a Lua value
    // -----------------------------------------------------------------------

    /**
     * Push a callable standing for the graph's action `latex` - `Y`, or `X` with its arguments
     * still to come. Called inside a body it merges its updates into the recording; called
     * outside one it fires on its own.
     */
    function pushAction(co, latex, isFunction) {
        C.lua_createtable(co, 0, 2);
        C.lua_pushstring(co, to_luastring(latex));
        C.lua_rawseti(co, -2, 1);
        C.lua_pushboolean(co, !!isFunction);
        C.lua_rawseti(co, -2, 2);
        pushActionMeta(co);
        C.lua_setmetatable(co, -2);
    }

    function pushActionMeta(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(ACTION_META));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 4);
        C.lua_pushcfunction(co, actionCall);
        C.lua_setfield(co, -2, to_luastring("__call"));
        C.lua_pushcfunction(co, actionToString);
        C.lua_setfield(co, -2, to_luastring("__tostring"));
        C.lua_pushcfunction(co, latexIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(ACTION_META));
    }

    function actionToString(co) {
        C.lua_rawgeti(co, 1, 1);
        var latex = C.lua_tojsstring(co, -1);
        C.lua_pop(co, 1);
        C.lua_pushstring(co, to_luastring("action " + latex));
        return 1;
    }

    /**
     * `Y()`, or `X(4)`. The arguments become the call's latex, so `X(4)` is the action
     * `X\left(4\right)` and Desmos works out what that means.
     */
    function actionCall(co) {
        C.lua_rawgeti(co, 1, 1);
        var base = C.lua_tojsstring(co, -1);
        C.lua_rawgeti(co, 1, 2);
        var takesArguments = C.lua_toboolean(co, -1);
        C.lua_pop(co, 2);

        var n = C.lua_gettop(co);
        if (takesArguments && n < 2)
            return fail(
                co,
                base +
                    " takes arguments - it is an action function, so call it with some"
            );
        if (!takesArguments && n > 1)
            return fail(
                co,
                base +
                    " takes no arguments - it is an action, not a function of one"
            );
        var parts = [];
        for (var i = 2; i <= n; i++) {
            var arg = lua.bridge.toDesmos(co, i);
            if (arg.error)
                return fail(
                    co,
                    "cannot pass that to " + base + ": " + arg.error
                );
            parts.push(arg.latex);
        }

        var latex = parts.length
            ? base + "\\left(" + parts.join(",") + "\\right)"
            : base;

        if (recorder) {
            // Inside a body there is no second fire to have: this action's updates belong to the
            // one already in flight, against the same pre-action state. Desmos is not here to
            // expand the call, so the graph's own latex is read and its `\to` pairs are taken
            // apart - which is also what makes "updates a twice" the error it should be.
            if (parts.length)
                return fail(
                    co,
                    "cannot call " +
                        base +
                        " with arguments from inside an action. Desmos substitutes a function's " +
                        "arguments, and it is not running yet - call it from the cell body instead"
                );

            var pairs = updatesOf(base);
            if (!pairs)
                return fail(
                    co,
                    "couldn't read what the action " + base + " updates"
                );
            for (var p = 0; p < pairs.length; p++)
                if (!record(co, pairs[p][0], pairs[p][1])) return 0;
            return 0;
        }

        return call(latex) ? 0 : fail(co, "couldn't run " + latex);
    }

    // -----------------------------------------------------------------------
    // recording a body
    // -----------------------------------------------------------------------

    /**
     * `latex = <the value at idx>`, from inside a body. The one-target-once rule lives here, and
     * it throws rather than returning false, so a body that breaks it stops where it broke and
     * the fire applies nothing at all.
     */
    function write(co, latex, idx) {
        if (!recorder) return false;

        if (C.lua_isnil(co, idx)) {
            // A probe runs the body with no arguments, so half its assignments are nil. That is
            // not an error - the probe exists to warm reads, not to be right.
            if (recorder.probe) return false;
            return fail(
                co,
                'an action cannot set "' +
                    latex +
                    '" to nil - there is no such Desmos value'
            );
        }

        var rhs = lua.bridge.toDesmos(co, idx);
        if (rhs.error) {
            if (recorder.probe) return false;
            return fail(co, 'cannot update "' + latex + '": ' + rhs.error);
        }
        return record(co, latex, rhs.latex);
    }

    /** One update, with the rule that makes an action an action. */
    function record(co, name, latex) {
        if (!recorder) return false;
        if (recorder.updates.has(name))
            return fail(
                co,
                'this action updates "' +
                    name +
                    '" more than once. A Desmos action assigns each variable at most once, ' +
                    "because every update happens at the same moment"
            );
        recorder.updates.set(name, latex);
        return true;
    }

    /**
     * Run the Lua function at `idx` as an action body and return what it recorded.
     *
     * `args` are pushed as its parameters. A plain lua_pcall rather than a resume: a body must
     * not park, and bridge.js reads lua_isyieldable to know that - inside a pcall it is false, so
     * a read that has no value yet takes latex instead of suspending the fire.
     */
    function record_body(co, idx, args, probe) {
        var outer = recorder;
        recorder = { updates: new Map(), probe: !!probe };

        C.lua_pushvalue(co, idx);
        (args || []).forEach(function (value) {
            lua.bridge.pushValue(co, value);
        });

        var status = C.lua_pcall(co, (args || []).length, 0, 0);
        var done = recorder;
        recorder = outer;

        if (status !== C.LUA_OK) {
            var why = C.lua_tojsstring(co, -1);
            C.lua_pop(co, 1);
            return { error: why || "error" };
        }
        return { updates: done.updates };
    }

    // -----------------------------------------------------------------------
    // exporting a Lua function as an action
    // -----------------------------------------------------------------------

    /**
     * `function X(n) ... end` - a global write whose value is a function - becomes the graph's
     * action `X`.
     *
     * The exported latex is a marker rather than the body, because the body is Lua and Desmos
     * evaluates in a worker:
     *
     *     X\left(L_{p0}\right) = \left(L_{ua3}\to L_{p0}\right)
     *
     * One marker variable per parameter, so the arguments ride in on the fire and a list
     * argument still works; a body with no parameters gets one marker that counts up, because an
     * action has to update something. ./index.js patches the line where Desmos applies an
     * action's updates, sees a marker among them, and runs the body there - inside the same fire,
     * which is what keeps a ticker at full speed and the updates simultaneous.
     *
     * The slot is keyed by cell and name rather than allocated per run, so re-running a cell
     * exports the same latex and Desmos sees nothing change.
     */
    function exportAction(co, cell, name, idx) {
        if (!cell) return false;

        var slot = slotFor(cell, name, arity(co, idx));
        hold(co, slot, idx);

        var updates = slot.markers.map(function (marker, i) {
            return slot.params.length
                ? marker + "\\to " + slot.params[i]
                : marker + "\\to " + marker + "+1";
        });

        var head = slot.params.length
            ? name + "\\left(" + slot.params.join(",") + "\\right)"
            : name;

        cell.exports.set(key(name), {
            latex: head + "=\\left(" + updates.join(",") + "\\right)",
            plot: false
        });
        // The markers need definitions of their own, or the action has nothing to update. They
        // are Lua-owned names, so they are statements like any other export - invisible, and
        // never reaching an item.
        slot.markers.forEach(function (marker) {
            cell.exports.set(key(marker), {
                latex: marker + "=0",
                plot: false
            });
        });

        // The probe: run the body once now, with parking allowed to the extent that a pcall
        // allows it, so every graph name the body reads becomes a watched helper. By the time it
        // fires those are numbers, which is what lets the body branch on them.
        record_body(co, idx, [], true);
        return true;
    }

    /** How many parameters the function at `idx` declares. Pops it, as lua_getinfo ">u" does. */
    function arity(co, idx) {
        C.lua_pushvalue(co, idx);
        var info = new C.lua_Debug();
        C.lua_getinfo(co, to_luastring(">u"), info);
        return info.nparams || 0;
    }

    /** The markers and parameter names for one cell's action, made once and kept. */
    function slotFor(cell, name, params) {
        if (!cell.actions) cell.actions = new Map();

        var slot = cell.actions.get(name);
        if (slot && slot.params.length === params) return slot;

        // A body whose parameter count changed needs new markers, and the old ones must stop
        // being recognised - a fire matching a marker no action mentions would run nothing.
        if (slot) release(cell, name);

        slot = { markers: [], params: [], cell: cell };
        var n = params || 1;
        for (var i = 0; i < n; i++) slot.markers.push(marker());
        for (var j = 0; j < params; j++) slot.params.push("L_{p" + j + "}");
        cell.actions.set(name, slot);
        return slot;
    }

    /**
     * Keep the body reachable from the registry, keyed by its first marker, so the fire can find
     * it and the collector cannot take it. Keyed by marker rather than by name because the marker
     * is what the fire actually sees.
     */
    function hold(co, slot, idx) {
        bodies(co);
        C.lua_pushvalue(co, idx);
        C.lua_setfield(co, -2, to_luastring(slot.markers[0]));
        C.lua_pop(co, 1);

        slot.markers.forEach(function (name) {
            live.set(norm(name), slot);
        });
    }

    function bodies(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(BODIES));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);
        C.lua_createtable(co, 0, 8);
        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(BODIES));
    }

    /** A name a cell no longer assigns: drop its action, if it had one. */
    function release(cell, name) {
        if (!cell || !cell.actions) return;
        var slot = cell.actions.get(name);
        if (!slot) return;
        cell.actions.delete(name);
        slot.markers.forEach(function (marker) {
            live.delete(marker);
            drop(marker);
        });
    }

    function drop(marker) {
        var L = F.L;
        bodies(L);
        C.lua_pushnil(L);
        C.lua_setfield(L, -2, to_luastring(marker));
        C.lua_pop(L, 1);
    }

    /** Every cell's markers go when the cell does. */
    function forget(cell) {
        if (!cell || !cell.actions) return;
        Array.from(cell.actions.keys()).forEach(function (name) {
            release(cell, name);
        });
    }

    // -----------------------------------------------------------------------
    // firing
    // -----------------------------------------------------------------------

    /**
     * The patch's end of things: the updates Desmos is about to apply, keyed by its own
     * identifier for each name and valued with the whole new latex of the assignment (`a=4`).
     *
     * A marker among them means one of our bodies is what fired. The body runs here, inside this
     * fire, and what it records is merged into the same map - so Desmos applies its updates and
     * Lua's in one go, and the pre-action state every right-hand side was computed against is
     * still the one on the graph.
     */
    function updates(map) {
        if (!map || typeof map !== "object") return map;

        var fired = new Map();
        var markers = [];

        Object.keys(map).forEach(function (id) {
            var slot = live.get(norm(id));
            if (!slot) return;
            markers.push(id);
            var args = fired.get(slot) || [];
            args[slot.markers.map(norm).indexOf(norm(id))] = rhs(map[id]);
            fired.set(slot, args);
        });
        if (!fired.size) return map;

        // A marker is bookkeeping. Nothing on the graph defines it as an item, so leaving it in
        // would be a no-op - but it would also be a lie about what this action did.
        markers.forEach(function (id) {
            delete map[id];
        });

        fired.forEach(function (args, slot) {
            merge(map, slot, args);
        });
        return map;
    }

    /** Run one body and fold its updates into the map Desmos is about to apply. */
    function merge(map, slot, args) {
        var co = F.L;

        bodies(co);
        C.lua_getfield(co, -1, to_luastring(slot.markers[0]));
        if (C.lua_type(co, -1) !== C.LUA_TFUNCTION) {
            C.lua_pop(co, 2);
            return;
        }

        var result = record_body(co, C.lua_gettop(co), args, false);
        C.lua_pop(co, 2);

        if (result.error) return broke(slot, result.error);

        // Desmos' own updates are already in the map, so a target in both is the same collision
        // as a target twice in one body - and it is caught before anything is applied.
        var taken = {};
        Object.keys(map).forEach(function (id) {
            taken[norm(id)] = true;
        });

        var clash = null;
        result.updates.forEach(function (latex, target) {
            if (taken[norm(target)]) clash = clash || target;
        });
        if (clash)
            return broke(
                slot,
                'this action updates "' +
                    clash +
                    '" more than once - the action it was run from updates it too'
            );

        var missing = null;
        result.updates.forEach(function (latex, target) {
            // A name a graph item defines goes back through Desmos, so it lands with everything
            // else. A Lua-owned name has no item to land in; ./index.js holds it.
            if (lua.defining(target))
                map[identifier(target)] = target + "=" + latex;
            else if (!lua.own(target, latex)) missing = missing || target;
        });

        // A target nothing defines at all: not an item, and not a statement any cell publishes.
        // Desmos calls this an update rule with an undefined left-hand side, and so do we.
        if (missing)
            broke(
                slot,
                'this action updates "' +
                    missing +
                    '", which nothing defines - give it a value first'
            );
    }

    /** A body that failed: the cell that exported it is where an error belongs. */
    function broke(slot, message) {
        if (slot.cell && lua.runner) lua.runner.blame(slot.cell, message);
        else console.error("lua:", message);
    }

    /**
     * Run a Desmos action by its latex, from a cell body rather than from inside a fire.
     *
     * An action the graph has as an item is Desmos' own to step, and `action-single-step` is how
     * its button does it. Anything else - a call like `X\left(4\right)`, which no item spells -
     * is handed to the evaluator as a statement of ours and stepped the same way.
     */
    function call(latex) {
        try {
            return lua.step(latex);
        } catch (error) {
            console.error("lua: couldn't run " + latex, error);
            return false;
        }
    }

    /**
     * Apply one update from a cell body, outside any action.
     *
     * A name a graph item defines is Desmos' to move, and `updateLatexForIdentifier` is its own
     * way of moving it - the same call the applier we patch makes, so a slider's bounds widen to
     * fit exactly as they would have. A name only Lua defines has no item, so it is ours.
     */
    function apply(name, latex) {
        var item = itemFor(name);
        if (!item) return lua.own(name, latex);

        var whole = name + "=" + latex;
        var before = item.latex;
        try {
            Calc.controller.updateLatexForIdentifier(identifier(name), whole);
        } catch (error) {
            // Fall through to the direct write below.
        }
        if (item.latex !== before) return true;

        // Either that method has moved or our identifier spelling is not Desmos'. Setting the
        // latex is what it does; what is lost is the slider-bound widening, not the update.
        try {
            item.latex = whole;
            lua.reparse();
            return true;
        } catch (error) {
            return false;
        }
    }

    /** The item defining `name`, if one does. ./index.js keeps the index that knows. */
    function itemFor(name) {
        var id = lua.defining(name);
        if (!id || !Calc) return null;
        try {
            return Calc.controller.getItemModel(id) || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Desmos' identifier for a Desmos name: the subscript loses its braces, so `a_{bcd}` is
     * `a_bcd`. A guess that apply() checks rather than trusts, and only ever used for writing -
     * a name coming the other way is matched with norm() instead, which needs no guess.
     */
    function identifier(name) {
        return name.replace(/_\{([A-Za-z0-9]+)\}/, "_$1");
    }

    /**
     * What the graph's action `name` updates, as `[[target, latex], ...]`, or null.
     *
     * Read off the defining item's own latex, because a nested call has to be folded into the
     * recording in flight and Desmos is not there to expand it. Only the shape an action actually
     * has is handled: a `\to` per update, commas between them at the top level, and a plain name
     * on the left of each. Anything else gives null and says so rather than guessing.
     */
    function updatesOf(name) {
        var item = itemFor(name);
        if (!item || typeof item.latex !== "string") return null;

        var at = item.latex.indexOf("=");
        if (at === -1) return null;
        var body = item.latex.slice(at + 1).trim();

        // One pair of outer brackets round a list of updates is Desmos' own spelling.
        var wrapped = /^\\left\((.*)\\right\)$/.exec(body);
        if (wrapped && depth(wrapped[1]) === 0) body = wrapped[1];

        var pairs = [];
        var parts = split(body, ",");
        for (var i = 0; i < parts.length; i++) {
            var sides = split(parts[i], "\\to");
            if (sides.length !== 2) return null;
            var target = sides[0].trim();
            if (!/^[A-Za-z](?:_\{[A-Za-z0-9]+\}|_[A-Za-z0-9])?$/.test(target))
                return null;
            pairs.push([target, sides[1].trim()]);
        }
        return pairs.length ? pairs : null;
    }

    /**
     * Split on `sep`, but only where the brackets are balanced - `\left(a,b\right)` is one part.
     * Counting `\left` and `\right` rather than the brackets themselves, because that is what
     * Desmos writes and a bare `{` from a subscript must not count.
     */
    function split(text, sep) {
        var parts = [];
        var at = 0;
        var level = 0;
        for (var i = 0; i < text.length; i++) {
            if (text.startsWith("\\left", i)) level++;
            else if (text.startsWith("\\right", i)) level--;
            else if (level === 0 && text.startsWith(sep, i)) {
                parts.push(text.slice(at, i));
                at = i + sep.length;
                i = at - 1;
            }
        }
        parts.push(text.slice(at));
        return parts;
    }

    /** How unbalanced `text` is, in `\left`/`\right` pairs. */
    function depth(text) {
        var level = 0;
        for (var i = 0; i < text.length; i++) {
            if (text.startsWith("\\left", i)) level++;
            else if (text.startsWith("\\right", i)) level--;
        }
        return level;
    }

    /** `a_{bcd}` and `a_bcd` both reduce to `a_bcd`, so the two spellings compare equal. */
    function norm(name) {
        return String(name).replace(/[{}]/g, "");
    }

    /** `a=4` -> the value 4; the update latex Desmos hands us is the whole assignment. */
    function rhs(whole) {
        var at = String(whole).indexOf("=");
        var text = at === -1 ? String(whole) : String(whole).slice(at + 1);

        if (/^-?\d+(?:\.\d+)?$/.test(text.trim())) return Number(text.trim());

        var list = /^\\left\[(.*)\\right\]$/.exec(text.trim());
        if (list) {
            var parts = list[1] ? list[1].split(",") : [];
            var numbers = parts.map(function (part) {
                return Number(part);
            });
            if (
                numbers.every(function (n) {
                    return !Number.isNaN(n);
                })
            )
                return numbers;
        }

        // Not a number this side can read. Hand it over as latex, which a body can still put
        // straight back into an update even though it cannot branch on it.
        return { latex: text };
    }

    function fail(co, message) {
        return lauxlib.luaL_error(co, to_luastring(message));
    }
})();
