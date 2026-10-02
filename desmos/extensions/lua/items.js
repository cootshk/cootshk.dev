// The graph as Lua objects: its items, its settings and its ticker.
//
//     Desmos.items.P.color = "#aabbcc"
//     Desmos.settings.showGrid = false
//     Desmos.ticker.playing = true
//
// All three are the same mechanism - a locked handle over a table of properties, a strict write,
// and a read that is a dependency - so they are one file. Items are most of it; the settings and
// the ticker are one object each, at the bottom.
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
//     Desmos.items.byId("17").hidden = true   -- by the id Desmos filed it under
//     Desmos.items.n.slider.max = 20          -- a property the saved graph nests
//     for i, item in pairs(Desmos.items) do print(i, item) end
//
// The brackets are the sheet and `byId` is the id, because those are different things: on
// almost every graph `Desmos.items[1]` and the item whose id is 1 are different rows.
//
// A handle is a **userdata** carrying the id, wearing the one metatable every handle here
// wears. Userdata because a table with everything on its metatable is only closed until
// somebody reaches past the metamethods - `rawset(item, "color", 1)` puts a real field on it,
// and __index/__newindex do not fire for a key the table already holds, so that handle would
// read back its own junk and write nowhere near the graph for as long as the page lasted.
// `rawget` and `rawset` refuse a userdata outright; `pairs`, `ipairs` and `#` do not.
//
// Handles are cached, so `Desmos.items.P == Desmos.items.P`, and `tostring` is the item's own
// latex - `print(Desmos.items[1])` is asked to find out which row this is.
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
// `Desmos.settings` and `Desmos.ticker` cover the other two things DesModder's text mode hangs
// `@{ }` off, with one wrinkle of their own: Desmos has rules about its settings that it keeps
// by *declining* - it will not lock the viewport while the zoom buttons show - so a setting is
// read back after it is written and the cell is told when Desmos would not have it.
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

    /** Registry key for the one metatable every handle wears. */
    var HANDLE_META = "cde.lua.handle";

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

    // Which kind of item each of them belongs to. Kept apart from the table above so that one
    // stays about behaviour; this is only ever read by the editor's completion list, where it
    // is most of what makes forty-odd names navigable - `image_url` is worth knowing not to
    // look for while an expression is what is being typed at.
    belong("any item", "id type folderId index defines secret hidden");
    belong(
        "an expression, or a table's column",
        "latex color colorLatex points pointOpacity pointSize pointStyle dragMode " +
            "lines lineOpacity lineWidth lineStyle fill fillOpacity"
    );
    belong(
        "an expression",
        "label showLabel labelSize labelOrientation labelAngle suppressTextOutline " +
            "interactiveLabel editableLabelMode displayEvaluationAsFraction " +
            "residualVariable isLogModeRegression " +
            Object.keys(GROUPS).join(" ")
    );
    belong("a note", "text");
    belong("a folder", "title collapsed");
    belong(
        "an image",
        "image_url name width height center angle opacity foreground draggable"
    );

    function belong(what, names) {
        names.split(" ").forEach(function (name) {
            if (PROPS[name]) PROPS[name].on = what;
        });
    }

    /**
     * The graph's own settings, which is the other thing DesModder's text mode hangs `@{ }`
     * off. Read off `controller.graphSettings` and written with `Calc.updateSettings`, which
     * has a whitelist of its own - so `direct` means the same here as it does above.
     *
     * Two of them are spelled differently by the API and by the model, and `at` is the model's
     * word: this is the one place the rule "the names are the saved graph's" is broken, because
     * `lockViewport` is what the API and text mode both call it and `userLockedViewport` is a
     * name nobody would guess.
     *
     * The 3D settings are only meaningful in the 3D calculator; in the 2D one they are written
     * and go nowhere, which is Desmos' behaviour and not something to pretend about.
     */
    var SETTINGS = {
        product: {
            read: function (settings) {
                return settings.product;
            }
        },
        viewport: { kind: "group", group: "viewport" },

        degreeMode: { kind: "flag" },
        complex: { kind: "flag" },
        randomSeed: { kind: "text" },
        squareAxes: { kind: "flag", direct: true },
        lockViewport: { kind: "flag", at: "userLockedViewport" },

        showGrid: { kind: "flag" },
        showXAxis: { kind: "flag" },
        showYAxis: { kind: "flag" },
        xAxisNumbers: { kind: "flag" },
        yAxisNumbers: { kind: "flag" },
        polarNumbers: { kind: "flag" },
        polarMode: { kind: "flag" },
        restrictGridToFirstQuadrant: { kind: "flag" },
        xAxisLabel: { kind: "text" },
        yAxisLabel: { kind: "text" },
        xAxisStep: { kind: "count" },
        yAxisStep: { kind: "count" },
        xAxisMinorSubdivisions: { kind: "count" },
        yAxisMinorSubdivisions: { kind: "count" },
        xAxisArrowMode: { kind: "enum", of: ["NONE", "POSITIVE", "BOTH"] },
        yAxisArrowMode: { kind: "enum", of: ["NONE", "POSITIVE", "BOTH"] },

        axis3D: { kind: "numbers", length: 3, direct: true },
        speed3D: { kind: "count", direct: true },
        worldRotation3D: { kind: "numbers", length: 9, direct: true },
        lockRotation: {
            kind: "flag",
            at: "userLockedRotation",
            direct: true
        },
        disableLighting: { kind: "flag", direct: true }
    };

    /**
     * `Desmos.settings.viewport`. Read live off `Calc.graphpaperBounds`, and written with
     * `Calc.setMathBounds`, which takes all four corners together - so one of them moving is
     * the other three as they are.
     *
     * `zmin` and `zmax` are read-only. They exist in the 3D calculator, `setMathBounds` is two
     * dimensional, and a way of writing them that cannot be tried here is not one to ship.
     */
    var VIEWPORT = {
        xmin: { kind: "count", corner: "left" },
        xmax: { kind: "count", corner: "right" },
        ymin: { kind: "count", corner: "bottom" },
        ymax: { kind: "count", corner: "top" },
        zmin: { read: depth("zmin") },
        zmax: { read: depth("zmax") }
    };

    /**
     * The ticker. All four on the model, which is enough: writing `playing` there really does
     * start it ticking, rather than only noting that something else had.
     */
    var TICKER = {
        handlerLatex: { kind: "text" },
        minStepLatex: { kind: "number" },
        playing: { kind: "flag" },
        open: { kind: "flag" }
    };

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

        /** Push the `Desmos.items` table. Called from bridge.pushNatives, for ./init.lua. */
        push: push,

        /** And `Desmos.settings` and `Desmos.ticker`, which are one object each. */
        pushSettings: function (co) {
            pushOne(co, "settings");
        },
        pushTicker: function (co) {
            pushOne(co, "ticker");
        },

        /** The graph has changed: re-read what cells are watching, and tell them what moved. */
        changed: changed,

        /** What comes after a dot, for the editor's completion list. */
        suggest: suggest,

        /**
         * Which kind of handle the value at `idx` is - "item", "settings", "ticker",
         * "viewport" - or null. bridge.desmosType asks, so `Desmos.type` can name one.
         */
        isHandle: function (co, idx) {
            var slot = held(co, idx);
            if (!slot) return null;
            return slot.which || (slot.group ? slot.group : "item");
        }
    };

    // -----------------------------------------------------------------------
    // the items table
    // -----------------------------------------------------------------------

    function push(co) {
        // A userdata for the reason a handle is one: `rawset(Desmos.items, 1, x)` on a table
        // would put a real field where __index looks, and poison the first row of the sheet for
        // every cell on the graph. Its own metatable, because __len and __pairs are the
        // sheet's and mean nothing on one item.
        C.lua_newuserdata(co, 0);

        C.lua_createtable(co, 0, 5);
        C.lua_pushcfunction(co, itemsIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, itemsNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, itemsPairs);
        C.lua_setfield(co, -2, to_luastring("__pairs"));
        C.lua_pushcfunction(co, itemsLen);
        C.lua_setfield(co, -2, to_luastring("__len"));
        lua.bridge.sealed(co);
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

        var key = C.lua_tojsstring(co, 2);

        // Through __index rather than sat in the table as a field, so the table stays empty and
        // every assignment to it still reaches __newindex - a field would be quietly
        // overwritable, because __newindex does not fire for a key the table already has.
        //
        // It costs the name `b_{yId}`, which this now answers for before the sheet is asked.
        // One Desmos name out of a possible few thousand, for a door the brackets cannot be.
        if (key === "byId") return pushById(co);

        var id = find(key);
        if (id === null) {
            C.lua_pushnil(co);
            return 1;
        }
        pushHandle(co, id, null);
        return 1;
    }

    /**
     * `Desmos.items.byId("200")` - the item Desmos filed under that id, wherever it sits.
     *
     * A door of its own, because the brackets are the sheet's: `Desmos.items[1]` is the first
     * row and not the item whose id is 1, and on almost every graph those are different items.
     * An id is a string to Desmos; a number is spelled as one here, so an id read off a
     * `getState()` can be handed over the way it looks.
     *
     * nil for an id nothing has, the same as every other lookup here.
     */
    function itemsById(co) {
        var t = C.lua_type(co, 1);
        if (t !== C.LUA_TNUMBER && t !== C.LUA_TSTRING)
            return fail(
                co,
                "Desmos.items.byId takes an id, as a number or a string"
            );

        var want =
            t === C.LUA_TNUMBER
                ? String(C.lua_tonumber(co, 1))
                : C.lua_tojsstring(co, 1);

        var list = all();
        for (var i = 0; i < list.length; i++)
            if (String(list[i].id) === want) {
                pushHandle(co, want, null);
                return 1;
            }

        C.lua_pushnil(co);
        return 1;
    }

    /** One `byId`, kept where the handles are so it is the same function every time. */
    function pushById(co) {
        if (cached(co, "f byId")) return 1;
        C.lua_pushcfunction(co, itemsById);
        keep(co, "f byId");
        return 1;
    }

    /**
     * __pairs for `Desmos.items`: the sheet in order, as `i, item`.
     *
     * The table holds nothing of its own - every lookup is a metamethod - so Lua's rawget-based
     * traversal finds an empty table, which is the same reason bridge.js gives `_G` a __pairs.
     * `ipairs` has always walked it, because that one goes through __index; this is what makes
     * `pairs` say the same thing.
     *
     * An iterator rather than a snapshot, so a long sheet does not build a handle for every row
     * before the loop body has seen the first one.
     */
    function itemsPairs(co) {
        C.lua_pushcfunction(co, itemsNext);
        C.lua_pushvalue(co, 1);
        C.lua_pushinteger(co, 0);
        return 3;
    }

    function itemsNext(co) {
        var at = C.lua_tointeger(co, 2) + 1;
        var list = all();
        if (at < 1 || at > list.length) {
            C.lua_pushnil(co);
            return 1;
        }
        // An integer, so `for i, item in pairs(...)` counts 1, 2, 3 rather than 1.0, 2.0, 3.0.
        C.lua_pushinteger(co, at);
        pushHandle(co, String(list[at - 1].id), null);
        return 2;
    }

    function itemsLen(co) {
        C.lua_pushinteger(co, all().length);
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
     * The handle for an item, for one of the objects it nests, or for the graph's own settings,
     * ticker and viewport. Made once and kept, so `Desmos.items.P == Desmos.items.P` and a
     * handle can be held in a local across a run.
     *
     * **A userdata, not a table.** A table with everything on its metatable is only closed
     * until somebody reaches past the metamethods. `rawset(item, "color", 1)` puts a real field
     * on it - and __index and __newindex do not fire for a key the table already holds - so
     * from then on that handle reads back its own junk and writes nowhere near the graph.
     * Handles are cached, so it would stay broken for as long as the page lasted. `rawget` and
     * `rawset` refuse a userdata outright ("table expected"), which is the whole of the fix,
     * and `pairs`, `ipairs` and `#` all still work through the metamethods below.
     *
     * **What it points at rides inside it.** fengari's userdata carries a plain JS object, so
     * the id goes there rather than into a closure - which means one metatable for every handle
     * this file hands out, instead of a fresh one holding three fresh closures per thing ever
     * asked about. `which` is set for the three that are not items, `group` for a nested object.
     *
     * The cache is bounded by the graph and never by how often a cell runs. A handle for an
     * item since deleted answers `id` and nil to everything else.
     */
    function pushHandle(co, id, group) {
        var key = group === null ? "i " + id : "g " + id + " " + group;
        if (cached(co, key)) return;

        var slot = C.lua_newuserdata(co, 0);
        slot.id = id;
        slot.group = group;

        pushHandleMeta(co);
        C.lua_setmetatable(co, -2);

        keep(co, key);
    }

    /**
     * The handle for the graph's settings, its viewport, or the ticker. One of each, and the
     * same metatable every other handle wears - `which` is what tells them apart.
     */
    function pushOne(co, which) {
        var key = "s " + which;
        if (cached(co, key)) return;

        var slot = C.lua_newuserdata(co, 0);
        slot.which = which;

        pushHandleMeta(co);
        C.lua_setmetatable(co, -2);

        keep(co, key);
    }

    /** The one metatable, made on first use and kept in the registry. */
    function pushHandleMeta(co) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLE_META));
        if (!C.lua_isnil(co, -1)) return;
        C.lua_pop(co, 1);

        C.lua_createtable(co, 0, 4);
        C.lua_pushcfunction(co, handleIndex);
        C.lua_setfield(co, -2, to_luastring("__index"));
        C.lua_pushcfunction(co, handleNewIndex);
        C.lua_setfield(co, -2, to_luastring("__newindex"));
        C.lua_pushcfunction(co, handleToString);
        C.lua_setfield(co, -2, to_luastring("__tostring"));
        lua.bridge.sealed(co);
        C.lua_setfield(co, -2, to_luastring("__metatable"));

        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLE_META));
    }

    /**
     * What the handle at `idx` points at.
     *
     * Only ever reached through the metatable above, which nothing but this file can attach -
     * `__metatable` is locked, so a cell cannot lift it off one handle and put it on something
     * else. The guard is for the shape of the thing rather than for a caller that could exist.
     */
    function held(co, idx) {
        return C.lua_type(co, idx) === C.LUA_TUSERDATA
            ? C.lua_touserdata(co, idx)
            : null;
    }

    /**
     * A property, as Lua sees it, from whichever of the three a handle stands for.
     *
     * An unknown one is nil rather than an error - that is what a table does, and
     * `if item.label then` has to work - while setting an unknown one *is* an error, because a
     * name Desmos does not know would silently do nothing.
     */
    function handleIndex(co) {
        var slot = held(co, 1);
        if (!slot || C.lua_type(co, 2) !== C.LUA_TSTRING) {
            C.lua_pushnil(co);
            return 1;
        }

        var name = C.lua_tojsstring(co, 2);
        if (slot.which) return readOne(co, slot.which, name);
        if (slot.group) return readSub(co, slot.id, slot.group, name);
        return readProp(co, slot.id, name);
    }

    function handleNewIndex(co) {
        var slot = held(co, 1);
        if (!slot) return fail(co, "that is not a handle of this extension's");
        if (C.lua_type(co, 2) !== C.LUA_TSTRING)
            return fail(co, "a property is named with a string");

        var name = C.lua_tojsstring(co, 2);
        if (slot.which) return writeOne(co, slot.which, name, 3);
        if (slot.group) return writeSub(co, slot.id, slot.group, name, 3);
        return writeProp(co, slot.id, name, 3);
    }

    /**
     * What a handle prints as.
     *
     * An item is its own latex, verbatim: `print(Desmos.items[1])` is asked to find out *which
     * row this is*, and the row is its latex - `A=\operatorname{polygon}\left(\left(1,2\right),
     * \left(3,4\right)\right)` says in one line what a list of forty properties would have
     * buried. It is also the one thing about an item this extension never has to guess at.
     *
     * An item with no latex says what it does hold instead: a note its text, a folder its
     * title. An image has neither, so it is named by what it is.
     */
    function handleToString(co) {
        var slot = held(co, 1);
        C.lua_pushstring(
            co,
            to_luastring(
                !slot
                    ? "a handle"
                    : slot.which
                      ? "the graph's " + slot.which
                      : slot.group
                        ? slot.group + " of item " + slot.id
                        : spell(modelOf(slot.id), slot.id)
            )
        );
        return 1;
    }

    function spell(model, id) {
        if (!model) return "item " + id + " (gone)";
        return (
            filled(model.latex) ||
            filled(model.text) ||
            filled(model.title) ||
            (model.type || "item") + " " + id
        );
    }

    /** A string with something in it, or null - the model spells "not set" as `""`. */
    function filled(value) {
        return typeof value === "string" && value !== "" ? value : null;
    }

    /**
     * The cache every handle lives in: one table in the registry, so a handle asked for twice
     * is the same object both times.
     *
     * Answers true with the cached value on the stack. Answers false with the *cache* on the
     * stack, for keep() to put the newly built value into - so a caller is a build between the
     * two and never has to spell the registry twice.
     */
    function cached(co, key) {
        C.lua_getfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLES));
        if (C.lua_isnil(co, -1)) {
            C.lua_pop(co, 1);
            C.lua_createtable(co, 0, 8);
            C.lua_pushvalue(co, -1);
            C.lua_setfield(co, C.LUA_REGISTRYINDEX, to_luastring(HANDLES));
        }

        C.lua_getfield(co, -1, to_luastring(key));
        if (C.lua_isnil(co, -1)) {
            C.lua_pop(co, 1);
            return false;
        }
        C.lua_remove(co, -2);
        return true;
    }

    /** File what is on top of the cache under `key`, and leave only it behind. */
    function keep(co, key) {
        C.lua_pushvalue(co, -1);
        C.lua_setfield(co, -3, to_luastring(key));
        C.lua_remove(co, -2);
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

        var value = propertyOf(model, spec, name, id);
        watch(dep(id, name), id, value, function () {
            return propertyOf(modelOf(id), spec, name, id);
        });
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

        var value = propertyOf(model[group], spec, name, id);
        watch(dep(id, group + "." + name), id, value, function () {
            var again = modelOf(id);
            return propertyOf(again && again[group], spec, name, id);
        });
        lua.bridge.pushValue(co, value);
        return 1;
    }

    /** The properties of a nested object, whether it hangs off an item or off the settings. */
    function grouped(name) {
        return GROUPS[name] ? GROUPS[name].props : shape(name);
    }

    /** Which properties `which` has, and where its values live. */
    function shape(which) {
        if (which === "settings") return SETTINGS;
        if (which === "ticker") return TICKER;
        return VIEWPORT;
    }

    function holder(which) {
        try {
            if (which === "settings") return Calc.controller.graphSettings;
            if (which === "ticker")
                return Calc.controller.getTicker
                    ? Calc.controller.getTicker()
                    : null;
            return Calc.graphpaperBounds
                ? Calc.graphpaperBounds.mathCoordinates
                : null;
        } catch (error) {
            // A build that keeps one of them somewhere else: nil, rather than throwing out
            // of a metamethod into whatever cell happened to ask.
        }
        return null;
    }

    /**
     * The z of the viewport, which `graphpaperBounds` does not carry because it is flat. The
     * saved state does, in the 3D calculator; read from there and nowhere in the 2D one.
     */
    function depth(name) {
        return function () {
            try {
                var graph = Calc.getState().graph || {};
                return (graph.viewport || {})[name];
            } catch (error) {
                return undefined;
            }
        };
    }

    function readOne(co, which, name) {
        var spec = shape(which)[name];
        if (!spec) {
            C.lua_pushnil(co);
            return 1;
        }
        if (spec.kind === "group") {
            pushOne(co, spec.group);
            return 1;
        }

        var key = "@" + which + "." + name;
        var again = function () {
            return propertyOf(holder(which), spec, name, null);
        };
        var value = again();
        watch(key, null, value, again);
        lua.bridge.pushValue(co, value);
        return 1;
    }

    function writeOne(co, which, name, idx) {
        var props = shape(which);
        var spec = props[name];
        if (!spec) return fail(co, missing(which, name, settableIn(props)));
        if (!spec.kind) return fail(co, readOnly(which, name));

        var stop = sealed(co, name);
        if (stop !== null) return stop;

        if (spec.kind === "group") return writeWhole(co, spec.group, idx);

        var given = coerce(co, spec, idx);
        if (given.error)
            return fail(co, 'cannot set "' + name + '": ' + given.error);
        if (alike(propertyOf(holder(which), spec, name, null), given.seen))
            return 0;

        return apply(
            co,
            name,
            "@" + which + "." + name,
            given.seen,
            function () {
                if (which === "ticker") return lua.setTicker(name, given.api);
                if (which === "viewport") return moveCorner(spec, given.api);
                lua.setSetting(name, given.api, !!spec.direct, spec.at || name);
            },
            // A setting is checked afterwards, because Desmos has rules about them that it
            // enforces by declining: it will not lock the viewport while the zoom buttons are
            // showing, and complex mode is in radians whatever `degreeMode` says. It says so at
            // the console and carries on, which from a cell looks like a line that did nothing
            // - so the line is made to say so instead.
            which === "settings"
                ? function () {
                      return propertyOf(holder(which), spec, name, null);
                  }
                : null
        );
    }

    /** `Desmos.settings.viewport = { xmin = -5, xmax = 5 }` - the named parts, the rest as is. */
    function writeWhole(co, which, idx) {
        var props = shape(which);
        if (C.lua_type(co, idx) !== C.LUA_TTABLE)
            return fail(
                co,
                'cannot set "' +
                    which +
                    '": it takes a table of ' +
                    settableIn(props).join(", ")
            );

        // The same check writeGroup() makes, for the same reason: the loop below walks the
        // property list, so a name that is not on it is a key nothing ever looks at. A
        // read-only one is named separately - `zmin` is real, and the reason it cannot be set
        // is worth saying rather than offering `zmax` as a near miss.
        var odd = stray(co, idx, props);
        if (odd)
            return fail(
                co,
                odd.name === undefined
                    ? 'cannot set "' +
                          which +
                          '": a property is named with a string, not a ' +
                          odd.type
                    : missing(which, odd.name, settableIn(props))
            );

        var fixed = stray(co, idx, settableSet(props));
        if (fixed && fixed.name !== undefined)
            return fail(co, readOnly(which, fixed.name));

        var names = settableIn(props);
        var touched = [];
        for (var i = 0; i < names.length; i++) {
            rawfield(co, idx, names[i]);
            if (C.lua_isnil(co, -1)) {
                C.lua_pop(co, 1);
                continue;
            }
            var given = coerce(co, props[names[i]], C.lua_absindex(co, -1));
            C.lua_pop(co, 1);
            if (given.error)
                return fail(
                    co,
                    'cannot set "' + names[i] + '": ' + given.error
                );
            touched.push([names[i], given]);
        }
        if (!touched.length) return 0;

        try {
            if (which === "viewport") {
                var corners = corner(null);
                touched.forEach(function (one) {
                    corners[props[one[0]].corner] = one[1].api;
                });
                lua.setBounds(corners);
            } else {
                touched.forEach(function (one) {
                    var spec = props[one[0]];
                    lua.setSetting(
                        one[0],
                        one[1].api,
                        !!spec.direct,
                        spec.at || one[0]
                    );
                });
            }
        } catch (error) {
            return fail(co, 'could not set "' + which + '": ' + why(error));
        }

        touched.forEach(function (one) {
            told("@" + which + "." + one[0], one[1].seen);
        });
        return 0;
    }

    /** Move one edge of the viewport, leaving the other three where they are. */
    function moveCorner(spec, value) {
        var corners = corner(null);
        corners[spec.corner] = value;
        lua.setBounds(corners);
    }

    /** The viewport as setMathBounds spells it. */
    function corner() {
        var now = holder("viewport") || {};
        return {
            left: now.xmin,
            right: now.xmax,
            bottom: now.ymin,
            top: now.ymax
        };
    }

    /** What `raw` is worth, in the spelling Lua reads it back in. */
    function valueOf(raw, spec) {
        // An empty latex is how the model spells "not set" - an untouched width, a label
        // nobody has typed - and nil is what that is in Lua. Left as the empty string it is
        // truthy, so `item.lineWidth or 2.5` would never reach its fallback.
        if (raw === undefined || raw === null || raw === "") return undefined;
        if (spec.kind === "flag") return raw === true;
        if (spec.kind === "numbers")
            return Array.isArray(raw) ? raw.slice() : undefined;
        if (spec.kind === "number" || spec.kind === "count" || spec.numbers)
            return numberish(raw);
        return typeof raw === "string" ? raw : String(raw);
    }

    /** One property of one thing, whatever kind of thing it is. */
    function propertyOf(holder, spec, name, id) {
        if (spec.read) return holder ? spec.read(holder, id) : undefined;
        if (!holder) return undefined;
        return valueOf(holder[spec.at || name], spec);
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
        if (alike(propertyOf(model, spec, name, id), given.seen)) return 0;

        return apply(co, name, dep(id, name), given.seen, function () {
            lua.setItem(id, name, given.api, !!spec.direct);
        });
    }

    /**
     * `item.slider.max = 20`: the whole-object write with one name in it.
     *
     * Not a path of its own. The two spellings have to mean the same thing, so there is one
     * place that writes a nested object and this is the shorter way of reaching it.
     */
    function writeSub(co, id, group, name, idx) {
        var g = GROUPS[group];
        var spec = g.props[name];
        if (!spec) return fail(co, missing(group, name, Object.keys(g.props)));

        var stop = sealed(co, group + "." + name);
        if (stop !== null) return stop;

        if (!modelOf(id))
            return fail(co, "that item is not on the graph any more");

        var given = coerce(co, spec, idx);
        if (given.error)
            return fail(
                co,
                'cannot set "' + group + "." + name + '": ' + given.error
            );

        return writeParts(co, id, group, [[name, given]]);
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

        // A name the group does not have is the mistake it is anywhere else, and this is the
        // only place that can see one: the loop below walks the *property list*, so it only
        // ever finds names that are already right. `item.slider = { maximum = 20 }` used to be
        // a table with nothing recognisable in it, which is to say a line that did nothing and
        // said nothing - while `item.slider.maximum = 20` named the typo.
        var odd = stray(co, idx, g.props);
        if (odd)
            return fail(
                co,
                odd.name !== undefined
                    ? missing(group, odd.name, Object.keys(g.props))
                    : 'cannot set "' +
                          group +
                          '": a property is named with a string, not a ' +
                          odd.type
            );

        // In the order the group declares rather than the order the table happens to hold, so
        // which of two bad values is reported does not depend on Lua's hashing.
        var touched = [];
        var names = Object.keys(g.props);
        for (var i = 0; i < names.length; i++) {
            rawfield(co, idx, names[i]);
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
            touched.push([names[i], given]);
        }

        return writeParts(co, id, group, touched);
    }

    /**
     * The first key of the table at `idx` that `props` does not have: `{ name }` for a string
     * key, `{ type }` for one that is not a string at all, and null when every key is a
     * property.
     *
     * Walked raw, for the reason rawfield() is raw: a cell can put a metatable on the table it
     * hands over, and this runs in places arbitrary Lua must not. `lua_next` reads the table
     * itself, so a `__index` has nothing to say here.
     *
     * The key is only read as a string once it is known to be one - converting a number key in
     * place is what the manual warns `next` about.
     */
    function stray(co, idx, props) {
        var at = C.lua_absindex(co, idx);
        var found = null;

        C.lua_pushnil(co);
        while (C.lua_next(co, at)) {
            if (found === null) {
                if (C.lua_type(co, -2) !== C.LUA_TSTRING)
                    found = {
                        type: F.to_jsstring(
                            C.lua_typename(co, C.lua_type(co, -2))
                        )
                    };
                else {
                    var name = C.lua_tojsstring(co, -2);
                    if (!props[name]) found = { name: name };
                }
            }
            C.lua_pop(co, 1);
        }
        return found;
    }

    /**
     * Set some of a nested object's parts. Both spellings end up here, which is the point:
     * `item.slider.max = 20` and `item.slider = { max = 20 }` are one write and cannot drift.
     *
     * **What is not named is not touched.** The patch starts as a copy of what the item has, so
     * setting `max` leaves `min`, its hard bound and the loop mode exactly as they were - a
     * table is a change to the parts it mentions, not a replacement of the object.
     *
     * **A part that would change nothing is dropped first.** A cell re-runs whenever anything
     * it read moves, so a cell that asserts a slider bound has nothing to say on almost every
     * run - and each write below costs a parse and a repaint, which for a cell on a ticker is
     * the graph writing to itself as fast as it can go. The whole-object spelling used to write
     * every time.
     *
     * **Three doors, and the property list says which.**
     *
     *   - `min`, `max` and `step` are `sliderBounds`, which is what sets `hardMin`/`hardMax` as
     *     it goes - and a bound without those does nothing at all. They go together, because
     *     that is the shape the API takes.
     *   - `isPlaying` is `playing`, which *starts* an animation where the model's own field
     *     would only be a note that one was running.
     *   - everything else is the model, which is what the saved state is built from.
     *
     * The model write is made only when a part actually needs it, so a bounds-only write is
     * still the single setExpression it always was; and it goes first, so the two API calls
     * have the last word on the fields they own.
     */
    function writeParts(co, id, group, touched) {
        var g = GROUPS[group];
        var held = (modelOf(id) || {})[group];

        var moving = touched.filter(function (one) {
            var spec = g.props[one[0]];
            return !alike(propertyOf(held, spec, one[0], id), one[1].seen);
        });
        if (!moving.length) return 0;

        var patch = merged(held, null, null);
        moving.forEach(function (one) {
            patch[one[0]] = one[1].api;
        });

        var onModel = moving.some(function (one) {
            var spec = g.props[one[0]];
            return !spec.bounds && !spec.api;
        });
        var bounded = moving.some(function (one) {
            return !!g.props[one[0]].bounds;
        });

        try {
            if (onModel) lua.setItem(id, group, patch, !g.api);
            if (bounded) lua.setItem(id, "sliderBounds", bounds(patch));
            moving.forEach(function (one) {
                var api = g.props[one[0]].api;
                if (api) lua.setItem(id, api, patch[one[0]]);
            });
        } catch (error) {
            return fail(
                co,
                'could not set "' +
                    (moving.length === 1 ? group + "." + moving[0][0] : group) +
                    '": ' +
                    why(error)
            );
        }

        moving.forEach(function (one) {
            told(dep(id, group + "." + one[0]), one[1].seen);
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
    function apply(co, name, key, seen, write, check) {
        try {
            write();
        } catch (error) {
            return fail(co, 'could not set "' + name + '": ' + why(error));
        }
        if (check) {
            var still = check();
            if (!alike(still, seen))
                return fail(
                    co,
                    'Desmos would not set "' +
                        name +
                        '" - it is still ' +
                        show(still) +
                        ". There is usually a reason at the console"
                );
        }
        told(key, seen);
        return 0;
    }

    /** A value in an error message. */
    function show(value) {
        if (value === undefined) return "unset";
        if (typeof value === "string") return '"' + value + '"';
        return String(value);
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
     * one - so a body that sets one has nothing an action could carry, and a function being
     * written down as latex has nowhere to put it either. It is caught here, during the probe,
     * which is before anything is painted: defining a body must not change the graph.
     */
    function sealed(co, name) {
        if (!lua.actions || !lua.actions.recording()) return null;
        return fail(
            co,
            `Cannot set "${name}" from a body being exported - a property is not part of an ` +
                "action, and not something a function can be written down as. Set it from the " +
                "cell body instead."
        );
    }

    /**
     * `t.name` without metamethods, pushed.
     *
     * Raw, because a cell can set a metatable on the table it hands over, and an `__index` here
     * would be arbitrary Lua running inside a property write - which happens in places Lua must
     * not run. What is written is what the table holds.
     */
    function rawfield(co, idx, name) {
        var at = C.lua_absindex(co, idx);
        C.lua_pushstring(co, to_luastring(name));
        C.lua_rawget(co, at);
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
            if (t !== C.LUA_TBOOLEAN) return { error: "expected a boolean" };
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
            if (t !== C.LUA_TSTRING) return { error: "expected a string" };
            var text = C.lua_tojsstring(co, idx);
            return { api: text, seen: text === "" ? undefined : text };
        }

        if (spec.kind === "color") {
            if (t !== C.LUA_TSTRING)
                return { error: 'expected a color ("#aabbcc", "red")' };
            var hex = colorOf(C.lua_tojsstring(co, idx));
            return { api: hex, seen: hex };
        }

        // A duration in milliseconds, or which way an animation runs. A real number, and one
        // of the few: everything else that looks like one is latex - see below.
        if (spec.kind === "count") {
            if (t !== C.LUA_TNUMBER) return { error: "expected a number" };
            var count = C.lua_tonumber(co, idx);
            if (!isFinite(count)) return { error: "expected a number" };
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
                if (written === null) return { error: "expected a number" };
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
            return { error: "expected a number or a latex string" };
        }

        // A fixed-length list of numbers: which way is up in the 3D calculator, and how it is
        // turned. Not latex - these really are numbers.
        if (spec.kind === "numbers") {
            // A list read off the graph is numbers too, and is not a Lua table any more.
            var answered = lua.bridge.listOf(co, idx);
            if (answered)
                return answered.length === spec.length
                    ? { api: answered, seen: answered }
                    : {
                          error: `expected ${spec.length} numbers, got ${answered.length}`
                      };
            if (t !== C.LUA_TTABLE)
                return {
                    error: `expected ${spec.length} numbers`
                };
            var n = C.lua_rawlen(co, idx);
            if (n !== spec.length)
                return {
                    error: `expected ${spec.length} numbers, got ${n}`
                };
            var list = [];
            for (var at = 1; at <= n; at++) {
                C.lua_rawgeti(co, idx, at);
                var number = C.lua_type(co, -1) === C.LUA_TNUMBER;
                var one = number ? C.lua_tonumber(co, -1) : 0;
                C.lua_pop(co, 1);
                if (!number || !isFinite(one))
                    return { error: "list contains non-numeric elements" };
                list.push(one);
            }
            return { api: list, seen: list };
        }

        var words = allowed(spec);
        // `labelSize` is one of three words or a latex number, and the number is latex for the
        // same reason a width is.
        if (spec.numbers && t === C.LUA_TNUMBER) {
            var size = C.lua_tonumber(co, idx);
            var spelled = isFinite(size) ? lua.bridge.num(size) : null;
            if (spelled === null) return { error: "expected a number" };
            return { api: spelled, seen: size };
        }
        if (t !== C.LUA_TSTRING)
            return {
                error:
                    "expected one of " +
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
        return settableIn(PROPS);
    }

    function settableIn(props) {
        return Object.keys(props).filter(function (name) {
            return !!props[name].kind;
        });
    }

    /** Why a property of the graph's own cannot be set. */
    function readOnly(which, name) {
        return which === "viewport"
            ? 'The viewport cannot be set directly. Try "setMathBounds" instead.'
            : `Unable to set "${name}".`;
    }

    /** The same list as an object, which is the shape stray() asks about. */
    function settableSet(props) {
        var out = {};
        settableIn(props).forEach(function (name) {
            out[name] = true;
        });
        return out;
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
        return `${what} has no "${name}".`;
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
    // the editor's completion list
    // -----------------------------------------------------------------------

    /**
     * What can follow the dot at the end of `before`, or null for "nothing special here".
     *
     * Literal paths only - `Desmos.settings.`, `Desmos.items.P.`, and any nested object by its
     * own name, so `n.slider.` works for a handle kept in a local even though `n.` cannot.
     * Nothing here is a type checker, and pretending otherwise would offer a list that is
     * wrong as often as it is right.
     *
     * What it does know it knows from the property tables themselves, so the list cannot drift
     * from what a write will actually take - including the enums, which are read live.
     */
    function suggest(before) {
        var text = String(before == null ? "" : before);
        if (!/\.$/.test(text)) return null;

        // An item is looked up by the name it defines, so the graph's own names are most of
        // this one - and `byId`, which is the door for the items that define none.
        if (/Desmos\.items\.$/.test(text))
            return [
                {
                    name: "byId",
                    detail: "byId(id)",
                    documentation: "gets a line by internal ID number",
                    kind: "property"
                }
            ].concat(
                lua.bridge.names().map(function (name) {
                    return { name: name, detail: "on the graph", kind: "name" };
                })
            );

        if (/Desmos\.settings\.viewport\.$/.test(text)) return listed(VIEWPORT);
        if (/Desmos\.settings\.$/.test(text)) return listed(SETTINGS);
        if (/Desmos\.ticker\.$/.test(text)) return listed(TICKER);

        // A nested object by its name: `Desmos.items.R.cdf.`, or `s.` where `s` was put in a
        // local. Before the item check, so `Desmos.items.P.slider.` is the slider's.
        var nested = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(text);
        if (nested && GROUPS[nested[1]]) return listed(GROUPS[nested[1]].props);

        // An item, however it was reached.
        if (
            /Desmos\.items\s*(?:\.[A-Za-z][A-Za-z0-9_]*|\[[^\]]*\])\s*\.$/.test(
                text
            )
        )
            return listed(PROPS);

        return null;
    }

    function listed(props) {
        return Object.keys(props).map(function (name) {
            var spec = props[name];
            return {
                name: name,
                detail: takes(spec),
                documentation: spec.on || null,
                kind: "property"
            };
        });
    }

    /** What a property will take, in words, out of the same spec the write is checked against. */
    function takes(spec) {
        if (!spec.kind) return "read-only";
        if (spec.kind === "flag") return "boolean";
        if (spec.kind === "text") return "string";
        if (spec.kind === "color") return "color";
        if (spec.kind === "number") return "number | latex string";
        if (spec.kind === "count") return "number";
        if (spec.kind === "numbers") return "number[]";
        if (spec.kind === "group")
            return "a group: " + Object.keys(grouped(spec.group)).join(", ");
        return (
            "one of " +
            allowed(spec).join(", ") +
            (spec.numbers ? ", or a number" : "")
        );
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

    /**
     * File a read, and remember what it was worth so changed() can tell when it moves.
     *
     * `again` re-reads it. A closure rather than enough fields to look it up with, because what
     * is being watched is a property of an item, of a nested object, of the graph's settings or
     * of the ticker, and only the closure knows which. `id` is the item it belongs to, or null
     * for the two that are not items - it is what says the entry can be dropped.
     */
    function watch(key, id, value, again) {
        note(key);
        var entry = watched.get(key);
        if (entry) entry.was = value;
        else watched.set(key, { id: id, was: value, again: again });
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
            var now = entry.again();
            if (alike(entry.was, now)) return;

            entry.was = now;
            if (entry.id !== null && !modelOf(entry.id)) gone.push(key);
            lua.bridge.onInvalidate(key, null);
        });

        gone.forEach(function (key) {
            watched.delete(key);
        });
    }

    function alike(a, b) {
        if (a === b) return true;
        if (Array.isArray(a) && Array.isArray(b))
            return (
                a.length === b.length &&
                a.every(function (one, i) {
                    return alike(one, b[i]);
                })
            );
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
