// Graph items as Lua objects: `Desmos.items.P.color = "#aabbcc"`.
//
// Reading a Desmos name gives its *value* - `P` is `{x = 1, y = 2}` - and that is the whole of
// the bridge in ./bridge.js. It leaves no room for the item itself: a value has no colour, a
// number cannot carry a metatable, and the things most worth styling - `y=x^{2}`, a circle, an
// image, a folder - define no name at all, so there is nothing to look them up by.
//
// So the item is a second thing, reached through a table of its own:
//
//     Desmos.items.P.color = "#aabbcc"        -- by the name it defines
//     Desmos.items["4"].hidden = true         -- by its id
//     Desmos.items[1].label = "first"         -- by where it sits on the sheet
//     Desmos.items.n.slider.max = 20          -- a property the saved graph nests
//     for i = 1, #Desmos.items do ... end
//
// A handle is an empty table with a per-item metatable; the id rides along as the metamethods'
// upvalue, and `__metatable` is locked, so a cell cannot lift the id out or reach the closures.
// Handles are cached, so `Desmos.items.P == Desmos.items.P`.
//
// **The property names are the saved graph's.** `pointSize`, `suppressTextOutline`,
// `parametricDomain` - what `getState()` calls them, nested exactly where it nests them. The
// set is DesModder's text mode `@{ }` schema, which is the most complete list of what a Desmos
// item has; the spellings are not, because text mode groups by what reads well
// (`points: @{ size: ... }`) and this groups by what the state actually is. `glesmos`,
// `errorHidden` and `pinned` are left out: those are DesModder's own metadata, kept in an
// expression of its own rather than on the item, so setting one here would mean nothing.
//
// **Two ways of writing.** `Calc.setExpression` is the door, and it has a whitelist: a property
// it does not recognise it drops without a word. What is on that list was measured against the
// live bundle, and the rest is written onto the item model, which is what `getState()` is built
// from - so it saves, it survives a state round trip, and reparse() is what makes the row and
// the graph paper catch up. Marked `direct` below, one property at a time, rather than guessed.
//
// Reading is a dependency like any other. `@<id>.color` goes into the cell's read set, the same
// set a Desmos name goes into, so runner.js re-runs the cell when the colour moves - and
// changed() below is what notices that it has, because Desmos' `change` event is the only word
// a style edit ever gets.
//
// Writing is *not* an export. Everything else this extension puts on the graph is a statement
// that vanishes when the cell stops saying it; a colour is a property of somebody's real item,
// so it is saved with the graph. The write is skipped when it would change nothing, which is
// what keeps a cell that re-runs often from doing anything at all most of the time.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    var F = window.fengari;
    var C = F.lua;
    var lauxlib = F.lauxlib;
    var to_luastring = F.to_luastring;

    /** Registry key for the handle cache: item -> the one handle table for it. */
    var HANDLES = "cde.lua.items";

    /** `{ min, max }`, which is the shape of every domain the state has. */
    var BOUNDS = {
        min: { kind: "number" },
        max: { kind: "number" }
    };

    /**
     * The properties the saved state nests, and what is in each.
     *
     * `api` says setExpression takes the whole object under this name; without it the object is
     * written onto the model. A sub-property with an `api` of its own goes through that instead
     * - `playing` is the one that starts an animation, and putting `isPlaying` on the model
     * would only say that one was running.
     *
     * `bounds` is the slider's min/max/step, which setExpression takes together as
     * `sliderBounds` - and which is worth going through, because it sets `hardMin`/`hardMax` as
     * it goes and a bound without those does nothing.
     */
    var GROUPS = {
        slider: {
            props: {
                min: { kind: "number", bounds: true },
                max: { kind: "number", bounds: true },
                step: { kind: "number", bounds: true },
                hardMin: { kind: "flag" },
                hardMax: { kind: "flag" },
                isPlaying: { kind: "flag", api: "playing" },
                loopMode: {
                    kind: "enum",
                    of: [
                        "LOOP_FORWARD_REVERSE",
                        "LOOP_FORWARD",
                        "PLAY_ONCE",
                        "PLAY_INDEFINITELY"
                    ]
                },
                animationPeriod: { kind: "count" },
                playDirection: { kind: "count" }
            }
        },
        parametricDomain: { api: true, props: BOUNDS },
        polarDomain: { api: true, props: BOUNDS },
        parametricDomain3Du: { props: BOUNDS },
        parametricDomain3Dv: { props: BOUNDS },
        parametricDomain3Dr: { props: BOUNDS },
        parametricDomain3Dphi: { props: BOUNDS },
        cdf: {
            props: {
                show: { kind: "flag" },
                min: { kind: "number" },
                max: { kind: "number" }
            }
        },
        clickableInfo: {
            props: {
                enabled: { kind: "flag" },
                description: { kind: "text" },
                latex: { kind: "text" },
                hoveredImage: { kind: "text" },
                depressedImage: { kind: "text" }
            }
        },
        vizProps: {
            props: {
                breadth: { kind: "number" },
                axisOffset: { kind: "number" },
                alignedAxis: { kind: "enum", of: ["x", "y"] },
                showBoxplotOutliers: { kind: "flag" },
                dotplotXMode: { kind: "enum", of: ["exact", "binned"] },
                binAlignment: { kind: "enum", of: ["left", "center"] },
                histogramMode: {
                    kind: "enum",
                    of: ["count", "relative", "density"]
                }
            }
        }
    };

    /**
     * What an item has.
     *
     * A `kind` is what makes a property settable; the rest are what the item *is*, and those
     * are read-only. `direct` means setExpression ignores it and it is written onto the model;
     * see the note at the top.
     *
     * The enums keep Desmos' own capitalisation, which is not consistent and is not ours to
     * tidy - `pointStyle` is `OPEN` and `labelOrientation` is `above`. What a cell writes is
     * matched without regard to case and stored the way Desmos spells it, and where Desmos
     * publishes an object for exactly this property (`from`) its values are accepted too, so a
     * value added since is not refused for not being listed here.
     */
    var PROPS = {
        // --- what it is -------------------------------------------------------
        id: {
            read: function (model, id) {
                return id;
            }
        },
        type: {
            read: function (model) {
                return model.type;
            }
        },
        folderId: {
            read: function (model) {
                return model.folderId;
            }
        },
        index: { read: indexOf },
        defines: { read: definesOf },

        // --- every item -------------------------------------------------------
        secret: { kind: "flag", direct: true },
        hidden: { kind: "flag" },

        // --- an expression, and a table's columns -----------------------------
        latex: { kind: "text" },
        color: { kind: "color" },
        colorLatex: { kind: "text", direct: true },
        points: { kind: "flag" },
        pointOpacity: { kind: "number" },
        pointSize: { kind: "number" },
        pointStyle: {
            kind: "enum",
            from: "Styles",
            of: ["POINT", "OPEN", "CROSS"]
        },
        dragMode: {
            kind: "enum",
            from: "DragModes",
            of: ["NONE", "X", "Y", "XY", "AUTO"]
        },
        lines: { kind: "flag" },
        lineOpacity: { kind: "number" },
        lineWidth: { kind: "number" },
        lineStyle: {
            kind: "enum",
            from: "Styles",
            of: ["SOLID", "DASHED", "DOTTED"]
        },
        fill: { kind: "flag" },
        fillOpacity: { kind: "number" },

        // --- what it says -----------------------------------------------------
        label: { kind: "text" },
        showLabel: { kind: "flag" },
        labelSize: {
            kind: "enum",
            from: "LabelSizes",
            of: ["small", "medium", "large"],
            numbers: true
        },
        labelOrientation: {
            kind: "enum",
            from: "LabelOrientations",
            of: [
                "default",
                "center",
                "center_auto",
                "auto_center",
                "above",
                "above_left",
                "above_right",
                "above_auto",
                "below",
                "below_left",
                "below_right",
                "below_auto",
                "left",
                "auto_left",
                "right",
                "auto_right"
            ]
        },
        labelAngle: { kind: "number", direct: true },
        suppressTextOutline: { kind: "flag", direct: true },
        interactiveLabel: { kind: "flag", direct: true },
        editableLabelMode: {
            kind: "enum",
            of: ["NONE", "MATH", "TEXT"],
            direct: true
        },

        // --- what else an expression carries ----------------------------------
        displayEvaluationAsFraction: { kind: "flag", direct: true },
        residualVariable: { kind: "text", direct: true },
        isLogModeRegression: { kind: "flag", direct: true },

        // --- a note -----------------------------------------------------------
        text: { kind: "text" },

        // --- a folder ---------------------------------------------------------
        title: { kind: "text", direct: true },
        collapsed: { kind: "flag", direct: true },

        // --- an image ---------------------------------------------------------
        image_url: { kind: "text", direct: true },
        name: { kind: "text", direct: true },
        width: { kind: "number", direct: true },
        height: { kind: "number", direct: true },
        center: { kind: "text", direct: true },
        angle: { kind: "number", direct: true },
        opacity: { kind: "number", direct: true },
        foreground: { kind: "flag", direct: true },
        draggable: { kind: "flag", direct: true }
    };

    // The nested ones, as properties of the item. `Desmos.items.n.slider.max = 20`.
    Object.keys(GROUPS).forEach(function (name) {
        PROPS[name] = { kind: "group", group: name };
    });

    /** A plain number written as a string, which is how the model holds a width or a bound. */
    var NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

    /** A definition's left-hand side, so an item can say which name it is. As index.js's. */
    var DEFINE =
        /^\s*([A-Za-z](?:_\{[A-Za-z0-9]+\}|_[A-Za-z0-9])?)\s*(?:\\left\([^=]*?\\right\))?\s*=/;

    /**
     * Every property a cell has read, by its dependency key: what it was worth at the time, and
     * enough to look it up again. changed() walks this on every graph change; there is one
     * entry per property actually read, so it is as big as the cells make it and no bigger.
     */
    var watched = new Map();

    var Calc = null;

    lua.items = {
        init: function (calc) {
            Calc = calc;
        },

        /** Push the `Desmos.items` table. Called from bridge.buildDesmos. */
        push: push,

        /** The graph has changed: re-read what cells are watching, and tell them what moved. */
        changed: changed
    };

    // -----------------------------------------------------------------------
    // the items table
    // -----------------------------------------------------------------------

    function push(co) {
        C.lua_createtable(co, 0, 0);

        C.lua_createtable(co, 0, 4);
        C.lua_pushcfunction(co, itemsIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, itemsNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, itemsLen);
        C.lua_setfield(co, -2, to_luastring("__len"));
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));
        C.lua_setmetatable(co, -2);
    }

    /**
     * `Desmos.items[k]`: the name an item defines, an id, or a position on the sheet.
     *
     * A number is a position so that `#Desmos.items` and `ipairs` mean something - Lua's own
     * way of walking a sequence, which is what the sheet is. A string is tried as a name first,
     * because a name is what a graph is written in and an id is an implementation detail that
     * only shows up when there is no name to use.
     */
    function itemsIndex(co) {
        var t = C.lua_type(co, 2);

        if (t === C.LUA_TNUMBER) {
            var at = C.lua_tonumber(co, 2);
            var list = all();
            if (at !== Math.floor(at) || at < 1 || at > list.length) {
                C.lua_pushnil(co);
                return 1;
            }
            pushHandle(co, String(list[at - 1].id), null);
            return 1;
        }

        if (t !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }

        var id = find(C.lua_tojsstring(co, 2));
        if (id === null) {
            C.lua_pushnil(co);
            return 1;
        }
        pushHandle(co, id, null);
        return 1;
    }

    function itemsLen(co) {
        C.lua_pushnumber(co, all().length);
        return 1;
    }

    function itemsNewIndex(co) {
        return fail(
            co,
            "Desmos.items is the sheet, not something to assign to. Set a property on an " +
                'item instead: Desmos.items.P.color = "#aabbcc"'
        );
    }

    /**
     * The id of the item `key` names, or null.
     *
     * A name is filed as a read even when nothing defines it, the same way bridge.envIndex
     * files one: a cell that asked for `Desmos.items.P` before `P` existed is a cell that wants
     * another go once it does, and index.js's announce() is what gives it one.
     */
    function find(key) {
        var latex = lua.bridge.toLatex(key);
        if (latex !== null) {
            note(latex);
            var id = lua.defining(latex);
            if (id) return String(id);
        }

        var list = all();
        for (var i = 0; i < list.length; i++)
            if (String(list[i].id) === key) return String(list[i].id);
        return null;
    }

    // -----------------------------------------------------------------------
    // a handle
    // -----------------------------------------------------------------------

    /**
     * The handle for an item, or for one of the objects it nests, made once and kept.
     *
     * One table per thing, so `Desmos.items.P == Desmos.items.P` and a handle can be held in a
     * local across a run. The table itself is empty: everything is on its metatable, and what
     * it points at is an upvalue of the metamethods rather than a field, so a cell has nothing
     * to rawget and nothing to overwrite.
     *
     * The cache holds one small table per thing ever asked about, which is bounded by the graph
     * and never by how often a cell runs. A handle for an item since deleted answers `id` and
     * nil to everything else.
     */
    function pushHandle(co, id, group) {
        var key = group === null ? id : id + " " + group;

        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLES));
        if (C.lua_isnil(co, -1)) {
            C.lua_pop(co, 1);
            C.lua_createtable(co, 0, 8);
            C.lua_pushvalue(co, -1);
            C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLES));
        }

        C.lua_getfield(co, -1, to_luastring(key));
        if (!C.lua_isnil(co, -1)) {
            C.lua_remove(co, -2);
            return;
        }
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 0);

        C.lua_createtable(co, 0, 4);
        if (group === null) {
            bind(co, [id], handleIndex, "__index");
            bind(co, [id], handleNewIndex, "__newindex");
            bind(co, [id], handleToString, "__tostring");
        } else {
            bind(co, [id, group], groupIndex, "__index");
            bind(co, [id, group], groupNewIndex, "__newindex");
            bind(co, [id, group], groupToString, "__tostring");
        }
        C.lua_pushliteral(co, "lua");
        C.lua_setfield(co, -2, to_luastring("__metatable"));
        C.lua_setmetatable(co, -2);

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, -3, to_luastring(key));
        C.lua_remove(co, -2);
    }

    /** One metamethod, with what it points at closed over. */
    function bind(co, upvalues, fn, name) {
        upvalues.forEach(function (text) {
            C.lua_pushstring(co, to_luastring(text));
        });
        C.lua_pushcclosure(co, fn, upvalues.length);
        C.lua_setfield(co, -2, to_luastring(name));
    }

    function handleIndex(co) {
        var id = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        if (C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }
        return readProp(co, id, C.lua_tojsstring(co, 2));
    }

    function handleNewIndex(co) {
        var id = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        if (C.lua_type(co, 2) !== C.LUA_TSTRING)
            return fail(co, "an item's property is named with a string");
        return writeProp(co, id, C.lua_tojsstring(co, 2), 3);
    }

    function handleToString(co) {
        var id = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        var model = modelOf(id);
        C.lua_pushstring(
            co,
            to_luastring(
                "item " + id + " (" + (model ? model.type : "gone") + ")"
            )
        );
        return 1;
    }

    function groupIndex(co) {
        var id = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        var group = C.lua_tojsstring(co, C.lua_upvalueindex(2));
        if (C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }
        return readSub(co, id, group, C.lua_tojsstring(co, 2));
    }

    function groupNewIndex(co) {
        var id = C.lua_tojsstring(co, C.lua_upvalueindex(1));
        var group = C.lua_tojsstring(co, C.lua_upvalueindex(2));
        if (C.lua_type(co, 2) !== C.LUA_TSTRING)
            return fail(co, "a property is named with a string");
        return writeSub(co, id, group, C.lua_tojsstring(co, 2), 3);
    }

    function groupToString(co) {
        C.lua_pushstring(
            co,
            to_luastring(
                C.lua_tojsstring(co, C.lua_upvalueindex(2)) +
                    " of item " +
                    C.lua_tojsstring(co, C.lua_upvalueindex(1))
            )
        );
        return 1;
    }

    // -----------------------------------------------------------------------
    // reading
    // -----------------------------------------------------------------------

    /**
     * A property, as Lua sees it. An unknown one is nil rather than an error - that is what a
     * table does, and `if item.label then` has to work - while setting an unknown one *is* an
     * error, because a name Desmos does not know would silently do nothing.
     */
    function readProp(co, id, name) {
        var spec = PROPS[name];
        var model = modelOf(id);

        // The one thing a handle can still answer for an item that has been deleted.
        if (name === "id") {
            C.lua_pushstring(co, to_luastring(id));
            return 1;
        }
        if (!spec || !model) {
            C.lua_pushnil(co);
            return 1;
        }
        if (spec.kind === "group") {
            pushHandle(co, id, spec.group);
            return 1;
        }

        var value = valueOf(model[name], spec, model, id);
        watch(dep(id, name), id, name, null, spec, value);
        lua.bridge.pushValue(co, value);
        return 1;
    }

    /** One of a nested object's properties: `item.slider.max`. */
    function readSub(co, id, group, name) {
        var spec = GROUPS[group].props[name];
        var model = modelOf(id);
        if (!spec || !model) {
            C.lua_pushnil(co);
            return 1;
        }

        var held = model[group];
        var value = valueOf(held ? held[name] : undefined, spec, model, id);
        watch(dep(id, group + "." + name), id, name, group, spec, value);
        lua.bridge.pushValue(co, value);
        return 1;
    }

    /** What `raw` is worth, in the spelling Lua reads it back in. */
    function valueOf(raw, spec, model, id) {
        if (spec.read) return spec.read(model, id);
        // An empty latex is how the model spells "not set" - an untouched width, a label
        // nobody has typed - and nil is what that is in Lua. Left as the empty string it is
        // truthy, so `item.lineWidth or 2.5` would never reach its fallback.
        if (raw === undefined || raw === null || raw === "") return undefined;
        if (spec.kind === "flag") return raw === true;
        if (spec.kind === "number" || spec.kind === "count" || spec.numbers)
            return numberish(raw);
        return typeof raw === "string" ? raw : String(raw);
    }

    /**
     * A width or a bound, which the model holds as latex. A plain number comes back as a
     * number; `2a` stays the string it is, because that is a real thing to put in the box.
     */
    function numberish(raw) {
        if (typeof raw === "number") return raw;
        var text = String(raw).trim();
        return NUMERIC.test(text) ? Number(text) : String(raw);
    }

    /** Where this item sits on the sheet, counting from 1 the way Lua does. */
    function indexOf(model, id) {
        var list = all();
        for (var i = 0; i < list.length; i++)
            if (String(list[i].id) === id) return i + 1;
        return undefined;
    }

    /** The Desmos name this item defines, as Lua spells it, or nil for one that defines none. */
    function definesOf(model) {
        var m = DEFINE.exec(String(model.latex == null ? "" : model.latex));
        if (!m) return undefined;
        var name = lua.bridge.toName(m[1].replace(/_([A-Za-z0-9]+)$/, "_{$1}"));
        return name === null ? undefined : name;
    }

    // -----------------------------------------------------------------------
    // writing
    // -----------------------------------------------------------------------

    /**
     * `item.color = "#aabbcc"`.
     *
     * Strict, the way `Desmos.k = v` is strict and a plain global write is not: there is no
     * `function f() end` case here, nothing that has to be quietly skipped, and a property
     * Desmos does not recognise is dropped on the floor by setExpression without a word.
     *
     * A write that would change nothing is not made at all. That is most of what keeps a cell
     * which asserts a style from doing any work: it re-runs whenever anything it reads moves,
     * and almost every one of those runs has nothing to say.
     */
    function writeProp(co, id, name, idx) {
        var spec = PROPS[name];
        if (!spec) return fail(co, missing("an item", name, settable()));
        if (!spec.kind)
            return fail(
                co,
                '"' + name + '" is what the item is, not something to set'
            );

        var stop = sealed(co, name);
        if (stop !== null) return stop;

        var model = modelOf(id);
        if (!model) return fail(co, "that item is not on the graph any more");

        // `item.slider = { max = 20 }` sets the parts it names and leaves the rest. A nil takes
        // the whole object off the item, which for `cdf` or `clickableInfo` is how it is turned
        // off at all.
        if (spec.kind === "group") return writeGroup(co, id, spec.group, idx);

        var given = coerce(co, spec, idx);
        if (given.error)
            return fail(co, 'cannot set "' + name + '": ' + given.error);
        if (alike(valueOf(model[name], spec, model, id), given.seen)) return 0;

        return apply(co, name, dep(id, name), given.seen, function () {
            lua.setItem(id, name, given.api, !!spec.direct);
        });
    }

    /** `item.slider.max = 20`. */
    function writeSub(co, id, group, name, idx) {
        var g = GROUPS[group];
        var spec = g.props[name];
        if (!spec) return fail(co, missing(group, name, Object.keys(g.props)));

        var stop = sealed(co, group + "." + name);
        if (stop !== null) return stop;

        var model = modelOf(id);
        if (!model) return fail(co, "that item is not on the graph any more");

        var given = coerce(co, spec, idx);
        if (given.error)
            return fail(
                co,
                'cannot set "' + group + "." + name + '": ' + given.error
            );

        var held = model[group];
        var now = valueOf(held ? held[name] : undefined, spec, model, id);
        if (alike(now, given.seen)) return 0;

        var key = dep(id, group + "." + name);
        return apply(co, name, key, given.seen, function () {
            var patch = merged(held, name, given.api);

            // The slider's bounds are one setting as far as the API is concerned, and going
            // through it is what sets hardMin/hardMax - a bound without those does nothing.
            if (spec.bounds)
                return lua.setItem(id, "sliderBounds", bounds(patch));
            // `playing` is what *starts* an animation; `isPlaying` on the model would only be
            // a note that one was running.
            if (spec.api) return lua.setItem(id, spec.api, given.api);
            lua.setItem(id, group, patch, !g.api);
        });
    }

    /** `item.slider = { max = 20 }`, or `item.cdf = nil`. */
    function writeGroup(co, id, group, idx) {
        var g = GROUPS[group];
        var t = C.lua_type(co, idx);

        if (t === C.LUA_TNIL)
            return apply(co, group, dep(id, group), undefined, function () {
                lua.setItem(id, group, undefined, true);
            });

        if (t !== C.LUA_TTABLE)
            return fail(
                co,
                'cannot set "' +
                    group +
                    '": it takes a table of ' +
                    Object.keys(g.props).join(", ") +
                    ", or nil to take it off"
            );

        var held = modelOf(id)[group];
        var patch = merged(held, null, null);
        var touched = [];

        var names = Object.keys(g.props);
        for (var i = 0; i < names.length; i++) {
            C.lua_getfield(co, idx, to_luastring(names[i]));
            if (C.lua_isnil(co, -1)) {
                C.lua_pop(co, 1);
                continue;
            }
            var given = coerce(co, g.props[names[i]], C.lua_absindex(co, -1));
            C.lua_pop(co, 1);
            if (given.error)
                return fail(
                    co,
                    'cannot set "' +
                        group +
                        "." +
                        names[i] +
                        '": ' +
                        given.error
                );
            patch[names[i]] = given.api;
            touched.push([names[i], given.seen]);
        }
        if (!touched.length) return 0;

        try {
            lua.setItem(id, group, patch, !g.api);
        } catch (error) {
            return fail(co, 'could not set "' + group + '": ' + why(error));
        }

        touched.forEach(function (one) {
            told(dep(id, group + "." + one[0]), one[1]);
        });
        told(dep(id, group), undefined);
        return 0;
    }

    /** A copy of a nested object with one field changed, since setting one replaces it whole. */
    function merged(held, name, value) {
        var out = {};
        for (var k in held || {}) out[k] = held[k];
        if (name !== null) out[name] = value;
        return out;
    }

    /** The slider bounds setExpression takes, out of a whole slider object. */
    function bounds(slider) {
        var out = {};
        ["min", "max", "step"].forEach(function (k) {
            if (slider[k] !== undefined && slider[k] !== "") out[k] = slider[k];
        });
        return out;
    }

    /**
     * Make the write, then say who is out of date.
     *
     * Our own cell is not told - the same rule bridge.settle follows for a value a cell moved -
     * and anyone *else* watching this property is told now rather than waiting for changed():
     * the echo guard in index.js means the change event this caused is the one scan() is
     * certain not to see.
     */
    function apply(co, name, key, seen, write) {
        try {
            write();
        } catch (error) {
            return fail(co, 'could not set "' + name + '": ' + why(error));
        }
        told(key, seen);
        return 0;
    }

    function told(key, seen) {
        var entry = watched.get(key);
        if (entry) entry.was = seen;
        if (lua.bridge.onInvalidate)
            lua.bridge.onInvalidate(key, lua.bridge.current());
    }

    /**
     * Whether this write is allowed to happen at all.
     *
     * An action is something Desmos runs on the graph, and a property of an item is not part of
     * one - so a body that sets one has no action to be. It is caught here, during the probe,
     * which is before anything is painted.
     */
    function sealed(co, name) {
        if (!lua.actions || !lua.actions.recording()) return null;
        return fail(
            co,
            'an action cannot set "' +
                name +
                '": an action is something Desmos runs on the graph, and a property of an ' +
                "item is not part of one. Set it in the cell body"
        );
    }

    function why(error) {
        return error && error.message ? error.message : String(error);
    }

    /** The Lua value at `idx` as the property wants it, and as a later read will see it. */
    function coerce(co, spec, idx) {
        var t = C.lua_type(co, idx);

        if (spec.kind === "flag") {
            // nil is "off" rather than an error: `item.hidden = nil` is how Lua spells clearing
            // a field, and there is nothing else it could mean here.
            if (t === C.LUA_TNIL) return { api: false, seen: false };
            if (t !== C.LUA_TBOOLEAN)
                return { error: "it takes true or false" };
            var on = !!C.lua_toboolean(co, idx);
            return { api: on, seen: on };
        }

        if (spec.kind === "text") {
            // The model holds the empty string for a label nobody has typed, and reading one
            // back gives nil again.
            if (t === C.LUA_TNIL) return { api: "", seen: undefined };
            if (t === C.LUA_TNUMBER) {
                var written = String(C.lua_tonumber(co, idx));
                return { api: written, seen: written };
            }
            if (t !== C.LUA_TSTRING) return { error: "it takes a string" };
            var text = C.lua_tojsstring(co, idx);
            return { api: text, seen: text === "" ? undefined : text };
        }

        if (spec.kind === "color") {
            if (t !== C.LUA_TSTRING)
                return { error: 'it takes a colour, like "#aabbcc" or "red"' };
            var hex = colorOf(C.lua_tojsstring(co, idx));
            return { api: hex, seen: hex };
        }

        // A duration in milliseconds, or which way an animation runs. A real number, and one
        // of the few: everything else that looks like one is latex - see below.
        if (spec.kind === "count") {
            if (t !== C.LUA_TNUMBER) return { error: "it takes a number" };
            var count = C.lua_tonumber(co, idx);
            if (!isFinite(count)) return { error: "it takes a number" };
            return { api: count, seen: count };
        }

        if (spec.kind === "number") {
            // A width, an opacity, a bound: the box holds *latex*, and Desmos parses what is
            // put there. A JavaScript number would be handed to that parser as a number and
            // throw - setExpression writes `14` down as "14" for us, and the model has nobody
            // to do that for it - so it is written down here, once, for both ways of writing.
            if (t === C.LUA_TNUMBER) {
                var v = C.lua_tonumber(co, idx);
                var written = isFinite(v) ? lua.bridge.num(v) : null;
                if (written === null) return { error: "it takes a number" };
                return { api: written, seen: v };
            }
            // A string is latex outright, which is the point: `2a` is a legal width.
            if (t === C.LUA_TSTRING) {
                var raw = C.lua_tojsstring(co, idx);
                return {
                    api: raw,
                    seen: raw === "" ? undefined : numberish(raw)
                };
            }
            return { error: "it takes a number, or latex as a string" };
        }

        var words = allowed(spec);
        // `labelSize` is one of three words or a latex number, and the number is latex for the
        // same reason a width is.
        if (spec.numbers && t === C.LUA_TNUMBER) {
            var size = C.lua_tonumber(co, idx);
            var spelled = isFinite(size) ? lua.bridge.num(size) : null;
            if (spelled === null) return { error: "it takes a number" };
            return { api: spelled, seen: size };
        }
        if (t !== C.LUA_TSTRING)
            return {
                error:
                    "it takes one of " +
                    words.join(", ") +
                    (spec.numbers ? ", or a number" : "")
            };

        var given = C.lua_tojsstring(co, idx);
        var word = pick(words, given);
        if (word === null)
            return {
                error: '"' + given + '" is not one of ' + words.join(", ")
            };
        return { api: word, seen: word };
    }

    /**
     * `given` as Desmos spells it, or null.
     *
     * Matched without regard to case because Desmos' own capitalisation is not consistent -
     * `pointStyle` is `OPEN` and `labelOrientation` is `above` - and a cell should not have to
     * know which is which. What is stored is always Desmos' spelling.
     */
    function pick(words, given) {
        var wanted = String(given).toUpperCase();
        for (var i = 0; i < words.length; i++)
            if (words[i].toUpperCase() === wanted) return words[i];
        return null;
    }

    /**
     * What this enum will take: what is written down above, plus whatever Desmos' own object
     * for it currently holds. The union, so a value Desmos has added since is accepted and a
     * build that has moved the object still refuses a typo.
     *
     * `Desmos.Styles` holds the point styles and the line styles together, so it widens both by
     * the other's three. Worth it: the alternative is refusing a style Desmos has added.
     */
    function allowed(spec) {
        var words = spec.of.slice();
        var live = spec.from && window.Desmos && window.Desmos[spec.from];
        if (!live) return words;

        for (var k in live) {
            if (typeof live[k] !== "string") continue;
            if (pick(words, live[k]) === null) words.push(live[k]);
        }
        return words;
    }

    /** `"red"` -> Desmos' own red; anything else is passed through as the CSS it is. */
    function colorOf(given) {
        var named = (window.Desmos && window.Desmos.Colors) || {};
        var hex = named[given.toUpperCase()];
        return typeof hex === "string" ? hex : given;
    }

    /** Every property a cell may set, for the errors above. */
    function settable() {
        return Object.keys(PROPS).filter(function (name) {
            return !!PROPS[name].kind;
        });
    }

    /**
     * What to say about a property that does not exist.
     *
     * A near miss is worth naming outright - `colour` for `color` is the whole reason this is
     * an error rather than a silent no-op - and where there is no near miss the full list of an
     * item's forty-odd properties is not something to read in a stack trace, so it is the first
     * few and where to find the rest.
     */
    function missing(what, name, names) {
        var near = nearest(name, names);
        if (near !== null)
            return (
                what + ' has no "' + name + '". Did you mean "' + near + '"?'
            );
        if (names.length <= 12)
            return what + ' has no "' + name + '". It has ' + names.join(", ");
        return (
            what +
            ' has no "' +
            name +
            '". Its properties are the ones the saved graph has: ' +
            names.slice(0, 8).join(", ") +
            ", and " +
            (names.length - 8) +
            " more - extensions/lua/README.md lists them"
        );
    }

    /** The one name within two edits of this one, if there is exactly one place to look. */
    function nearest(name, names) {
        var best = null;
        var score = 3;
        var wanted = name.toLowerCase();

        names.forEach(function (one) {
            var d = edits(wanted, one.toLowerCase(), score);
            if (d < score) {
                score = d;
                best = one;
            }
        });
        return best;
    }

    /** Levenshtein, given up on past `cap` - which here is three, so it stays cheap. */
    function edits(a, b, cap) {
        if (Math.abs(a.length - b.length) >= cap) return cap;

        var row = [];
        for (var j = 0; j <= b.length; j++) row.push(j);

        for (var i = 1; i <= a.length; i++) {
            var previous = row[0];
            row[0] = i;
            var least = i;
            for (var k = 1; k <= b.length; k++) {
                var was = row[k];
                row[k] = Math.min(
                    row[k] + 1,
                    row[k - 1] + 1,
                    previous + (a[i - 1] === b[k - 1] ? 0 : 1)
                );
                previous = was;
                if (row[k] < least) least = row[k];
            }
            if (least >= cap) return cap;
        }
        return row[b.length];
    }

    // -----------------------------------------------------------------------
    // keeping cells up to date
    // -----------------------------------------------------------------------

    /**
     * The dependency key for one property of one item.
     *
     * `@` because a Desmos latex never starts with one and neither does the `_:` a shared
     * global is filed under - so these share runner.js's one dependency map without colliding.
     */
    function dep(id, name) {
        return "@" + id + "." + name;
    }

    /** File this read against the running cell, exactly as bridge.note files a Desmos name. */
    function note(key) {
        var cell = lua.bridge.current();
        if (!cell) return;
        if (lua.actions && lua.actions.probing()) cell.probeReads.add(key);
        else cell.reads.add(key);
    }

    function watch(key, id, name, group, spec, value) {
        note(key);
        var entry = watched.get(key);
        if (entry) entry.was = value;
        else
            watched.set(key, {
                id: id,
                name: name,
                group: group,
                spec: spec,
                was: value
            });
    }

    /**
     * Somebody has changed the graph: re-run the cells that were reading whatever moved.
     *
     * Called from index.js's scan(), which is the `change` event - the only word a style edit
     * ever gets. A helper never hears about one, because a colour is not a value the evaluator
     * publishes.
     *
     * An item that has been deleted is a change like any other, and its entry goes with it.
     */
    function changed() {
        if (!watched.size || !lua.bridge.onInvalidate) return;

        var gone = [];
        watched.forEach(function (entry, key) {
            var model = modelOf(entry.id);
            var now;
            if (model) {
                var held = entry.group ? model[entry.group] : model;
                now = valueOf(
                    held ? held[entry.name] : undefined,
                    entry.spec,
                    model,
                    entry.id
                );
            }
            if (alike(entry.was, now)) return;

            entry.was = now;
            if (!model) gone.push(key);
            lua.bridge.onInvalidate(key, null);
        });

        gone.forEach(function (key) {
            watched.delete(key);
        });
    }

    function alike(a, b) {
        if (a === b) return true;
        return (
            typeof a === "number" &&
            typeof b === "number" &&
            Number.isNaN(a) &&
            Number.isNaN(b)
        );
    }

    // -----------------------------------------------------------------------
    // the graph
    // -----------------------------------------------------------------------

    function all() {
        try {
            var list = lua.itemList();
            if (list && typeof list.length === "number") return list;
        } catch (error) {
            // Nothing to offer; an empty sheet reads as one.
        }
        return [];
    }

    function modelOf(id) {
        try {
            var model = Calc.controller.getItemModel(id);
            if (model) return model;
        } catch (error) {
            // A build that moved it: fall back on the list, which is where it would be anyway.
        }
        var list = all();
        for (var i = 0; i < list.length; i++)
            if (String(list[i].id) === id) return list[i];
        return null;
    }

    function fail(co, message) {
        return lauxlib.luaL_error(co, to_luastring(message));
    }
})();
