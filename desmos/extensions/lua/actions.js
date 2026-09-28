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
        export: exportFunction,
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

    /**
     * Comparing a fragment. Two different situations, and they want opposite things.
     *
     * During a **probe** the answer does not matter and getting past the comparison does: the
     * probe is asking what this function *is*, and a body that only updates something inside an
     * `if` would otherwise look like a body that updates nothing. So it takes the branch and
     * marks the recording blind - which costs the probe its right to be written down as latex,
     * because a branch taken on a guess is not the function anyone wrote. See exportFunction.
     *
     * During a **fire** the answer is the answer, and there isn't one: the graph has not said
     * what this is yet, and the fire cannot wait. That is worth stopping for.
     */
    function latexCompare(co) {
        if (recorder && recorder.probe) {
            recorder.blind = true;
            C.lua_pushboolean(co, true);
            return 1;
        }
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

    /**
     * One update, with the rule that makes an action an action.
     *
     * The rule is not enforced during a probe. A probe is asking *what this function is*, not
     * whether it is correct - and the answer it needs, "it updates something", is already known
     * by the time the second update to the same name arrives. Erroring here would drop the
     * function from the graph entirely and say nothing about why; the fire is where a duplicate
     * matters and where there is somewhere to report it.
     */
    function record(co, name, latex) {
        if (!recorder) return false;
        if (recorder.updates.has(name) && recorder.probe) return true;
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
            push(co, value);
        });

        var status = C.lua_pcall(co, (args || []).length, 1, 0);
        if (status !== C.LUA_OK) {
            recorder = outer;
            return { error: why(co) };
        }

        // What it handed back decides what it *is* - see exportFunction. A function means an
        // action, and running the action means running that one too, so it happens here while
        // the recording is still open and the one-target-once rule still spans both.
        var gave = C.lua_type(co, -1);
        var result = {
            updates: null,
            gave: gave,
            latex: null,
            blind: !!recorder.blind
        };

        if (gave === C.LUA_TFUNCTION) {
            var inner = C.lua_pcall(co, 0, 0, 0);
            if (inner !== C.LUA_OK) {
                var bad = why(co);
                if (!probe) {
                    recorder = outer;
                    return { error: bad };
                }
                // A probe is discovery. It already knows what this is - a function was handed
                // back - and it ran the inner only to find out what that one reads.
            }
        } else {
            if (gave !== C.LUA_TFUNCTION && gave !== C.LUA_TNIL) {
                var value = lua.bridge.toDesmos(co, C.lua_gettop(co));
                result.latex = value.error ? null : value.latex;
            }
            C.lua_pop(co, 1);
        }

        result.updates = recorder.updates;
        result.blind = !!recorder.blind;
        recorder = outer;
        return result;
    }

    /**
     * Why a pcall failed, as something worth reading. Pops the error value.
     *
     * The message comes from bridge.describe, which knows what to do with an error value that is
     * not a string - a table, a nil, and above all a JS exception thrown out of one of this
     * extension's own C functions, which used to arrive as the bare word "error".
     *
     * The traceback goes on for the reason runner.js puts one on: the line number is most of what
     * turns "attempt to index a nil value" into somewhere to look.
     */
    function why(co) {
        var message = lua.bridge.describe(co);
        C.lua_pop(co, 1);

        try {
            lauxlib.luaL_traceback(co, co, to_luastring(message), 1);
            var full = C.lua_tojsstring(co, -1);
            C.lua_pop(co, 1);
            return full || message;
        } catch (error) {
            return message;
        }
    }

    /** A JS value as a Lua one, latex fragments included. bridge.pushValue knows the rest. */
    function push(co, value) {
        if (
            value &&
            typeof value === "object" &&
            typeof value.latex === "string"
        )
            return pushLatex(co, value.latex);
        lua.bridge.pushValue(co, value);
    }

    // -----------------------------------------------------------------------
    // exporting a Lua function
    // -----------------------------------------------------------------------

    /**
     * A global write whose value is a function. Which of the two things it becomes is decided by
     * running it once, here, and looking at what comes back:
     *
     *     function A(n) return n + 2 end                 ->  A\left(L_{p0}\right)=L_{p0}+2
     *     function A(n) return function() ... end end    ->  an action
     *     function X(n) a = n end                        ->  an action
     *
     * **A function that only computes is a Desmos function.** It is run with its parameters
     * standing in as latex fragments, so `n + 2` composes `L_{p0}+2` and the export is a real
     * Desmos function - `A(3)` is 5, it can be plotted, and Desmos can differentiate it. Nothing
     * about it is Lua once it has been written down.
     *
     * **A function that hands back a function, or that updates anything, is an action.** The
     * first is how you ask for one outright; the second is what an assignment to a Desmos name
     * already means. Neither can be written down as latex, so those get the marker below.
     *
     * A body that cannot be run this way at all - one that compares a fragment, say, or a
     * recursive helper that branches on its argument - is neither, and is left as what it always
     * was: a Lua global the cell next door can call. That silence is the same one a string gets.
     */
    function exportFunction(co, cell, name, idx) {
        if (!cell) return false;

        var params = arity(co, idx);
        var probe = probeBody(co, idx, params);

        if (probe.error || (probe.gave === C.LUA_TNIL && !probe.updates.size)) {
            // Nothing to say about it. Drop any action it used to be, so a body that stops
            // updating stops being an action too.
            release(cell, name);
            cell.exports.delete(key(name));
            return false;
        }

        if (probe.gave === C.LUA_TFUNCTION || probe.updates.size)
            return asAction(co, cell, name, params, idx);

        // A probe that guessed its way past a comparison found out whether the body updates
        // anything - which is all the line above needed - but not what it computes. Writing
        // down the branch it happened to take would be writing down a different function.
        if (probe.blind || probe.latex === null) {
            release(cell, name);
            cell.exports.delete(key(name));
            return false;
        }

        release(cell, name);
        cell.exports.set(key(name), {
            latex: signature(name, params) + "=" + probe.latex,
            plot: false
        });
        return true;
    }

    /**
     * Run the body once with its parameters as latex fragments.
     *
     * Two jobs. It decides what the function is - see above - and it warms the graph: every name
     * the body reads becomes a watched helper here, so by the time an action fires those are
     * numbers rather than latex.
     *
     * That second job is why a body handing back a function is run *and then* the function it
     * handed back is run too. The reads that matter are usually in there - `function C(x) return
     * function() m = n + m + x end end` reads nothing at all until the inner one runs - and a
     * name still cold when the action fires comes back as latex, which for `m = n + m + x` would
     * hand Desmos `m=n+m+3`: a definition in terms of itself, which is not an update at all.
     *
     * A fragment argument is what makes the Desmos-function case work at all: `n` has no value
     * yet and never will, so it stands for itself.
     */
    function probeBody(co, idx, params) {
        var args = [];
        for (var i = 0; i < params; i++) args.push({ latex: "L_{p" + i + "}" });
        return record_body(co, idx, args, true);
    }

    /** `A` with no parameters, `A\left(L_{p0}\right)` with one. */
    function signature(name, params) {
        if (!params) return name;
        var names = [];
        for (var i = 0; i < params; i++) names.push("L_{p" + i + "}");
        return name + "\\left(" + names.join(",") + "\\right)";
    }

    /**
     * The action half. The exported latex is a marker rather than the body, because the body is
     * Lua and Desmos evaluates in a worker:
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
    function asAction(co, cell, name, params, idx) {
        var slot = slotFor(cell, name, params);
        hold(co, slot, idx);

        var updates = slot.markers.map(function (marker, i) {
            return slot.params.length
                ? marker + "\\to " + slot.params[i]
                : marker + "\\to " + marker + "+1";
        });

        cell.exports.set(key(name), {
            latex:
                signature(name, params) +
                "=\\left(" +
                updates.join(",") +
                "\\right)",
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

        slot = { markers: [], params: [], cell: cell, name: name };
        var n = params || 1;
        for (var i = 0; i < n; i++) slot.markers.push(marker());
        for (var j = 0; j < params; j++) slot.params.push("L_{p" + j + "}");
        // Same spelling signature() uses, and the same one probeBody() stands in with.
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

        // An update whose right-hand side still names its own target is not an update - it is a
        // definition in terms of itself, and writing it would replace a working expression with a
        // broken one. It means a value the body read was not warm yet, so the read became latex
        // rather than a number; see probeBody. Say so rather than corrupt the graph.
        var circular = null;
        result.updates.forEach(function (latex, target) {
            if (mentions(latex, target)) circular = circular || target;
        });
        if (circular)
            return broke(
                slot,
                'this action sets "' +
                    circular +
                    '" to an expression that still mentions it, which Desmos would read as a ' +
                    "definition in terms of itself. The graph had not said what it was worth yet - " +
                    "run it again"
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

    /**
     * A body that failed: the cell that exported it is where an error belongs.
     *
     * Named, because a fire is not a run - there is no line the user just typed to tie it to, and
     * a cell can export more than one action. "C: ..." says which.
     */
    function broke(slot, message) {
        var named = (slot && slot.name ? slot.name + ": " : "") + message;
        if (slot && slot.cell && lua.runner) lua.runner.blame(slot.cell, named);
        else console.error("lua:", named);
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

    /**
     * Does `latex` use the Desmos name `name`? The lookahead keeps `m` from matching `m_{1}`,
     * and the lookbehind-by-hand keeps it from matching the tail of a longer name.
     */
    function mentions(latex, name) {
        var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
            "(^|[^A-Za-z_])" + escaped + "(?![A-Za-z0-9_{])"
        ).test(String(latex));
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
