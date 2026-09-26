// The UI extensions draw, and the runtime that hosts it.
//
// Desmos owns the whole document, so an extension that wants to put something next to its
// chrome has to build it out of what Desmos put there. This runtime is what it builds with.
// It brings no styling of its own - an extension that needs some ships an index.css beside
// its index.js (see extensions/README.md), and the loader hands it to ui.css() before any of
// its hooks run.
//
// It is window.__desmosExt.ui, and every hook that runs after the swap can reach it:
//
//   ui.el(tag, props, ...children)     build a DOM node - or fill one, if `tag` is already
//                                      an element. `class` and `text` are spelled out, on*
//                                      props are listeners, booleans become properties and
//                                      everything else an attribute. Null children are
//                                      skipped, so `cond ? node : null` reads the way it
//                                      looks (unlike Element.append, which writes "null").
//   ui.css(key, text)                  add a stylesheet to the page, once per key. An
//                                      extension's index.css arrives this way already; this
//                                      is for anything that has to be computed.
//
//   ui.list() / ui.get(id)             what extensions.json says about every extension,
//                                      plus `supported` (this calculator), `forced`
//                                      (forceEnabled) and `active` (running right now).
//   ui.enabled(id)                     is it meant to be on? - the toggle's state.
//   ui.setEnabled(id, on)              flip a toggle. Nothing is written down until apply().
//   ui.locked(id)                      is that toggle read-only?
//   ui.overridden()                    is ?ext= deciding instead of the toggles?
//   ui.unlock() / ui.unlocked()        edit the toggles anyway, while ?ext= is there.
//   ui.dirty()                         does what is toggled on differ from what is running?
//   ui.onDirty(fn) -> off              called when that answer may have changed.
//   ui.apply()                         write the toggles down and reload onto them.
//   ui.reload()                        reload the page as it stands.
//
//   ui.wantedByGraph()                 what the open graph asks to be opened with.
//   ui.hasRequired()                   is it requiring anything this load?
//   ui.unlockRequired() / ui.requiredUnlocked()
//                                      edit those toggles anyway.
//   ui.resetRequired()                 put them back the way the graph wants them.
//   ui.ignoringGraph()                 is that list being turned down for this graph?
//   ui.restoreGraph()                  take that back, and reload.
//
// Toggling is a draft: setEnabled() only moves a switch, and nothing outlives the page until
// apply() writes the whole set down. That is what makes unlock() safe - a ?ext= address can
// be examined, and even edited, without quietly rewriting what the next visit loads.
//
// An extension the graph requires reads as on, because it is, and starts locked like a forced
// one - a graph asking for what it needs to draw correctly is the ordinary case, and not
// something to be switched off by accident. unlockRequired() frees those switches; turning
// one off and applying is what turns the graph's list down, and the answer is remembered
// against that one graph, so the same extension still arrives with the next graph that wants
// it. resetRequired() undoes the editing; restoreGraph() undoes the refusal.
//
//   ui.slot(name, render)              offer a named mount point. render(root, data) draws
//                                      into a fresh element and may return a teardown
//                                      function.
//   ui.mount(name, root, data)         fill one. Patched Desmos code calls this from a
//                                      didMount, and a slot registered later still lands.
//                                      `data` is whatever that call site can reach and the
//                                      renderer cannot - the my-graphs tabs are handed the
//                                      modal's controller this way.
//   ui.unmount(root)                   the matching willUnmount.
//
//   ui.panel(id, render, data)         an extension's own settings, drawn on its card in the
//                                      Extensions tab. The `ui` hook registers this for you.
//   ui.hasPanel(id) / ui.renderPanel(id, root)
//
// The tabs in Desmos' my-graphs modal are extensions/settings/: it patches the modal to
// call ui.mount("cde-<tab>", el) for each one, fills those slots, and styles them from its
// own index.css.

/**
 * window.__desmosExt.ui. Called by desmos.js once the document has been swapped, before any
 * extension hook, with:
 *
 *   { storage, overridden, extensions: [{id, name, description, supported, forced,
 *                                        default, active}] }
 */
function uiRuntime(config) {
    var g = window;
    var ext = (g.__desmosExt = g.__desmosExt || {});

    var catalog = config.extensions || [];
    var byId = {};
    catalog.forEach(function (entry) {
        byId[entry.id] = entry;
    });

    // ---------------------------------------------------------------------------
    // building blocks
    // ---------------------------------------------------------------------------

    function append(node, child) {
        if (child === null || child === undefined || child === false) return;
        if (Array.isArray(child))
            return child.forEach(function (one) {
                append(node, one);
            });
        node.appendChild(
            typeof child === "object"
                ? child
                : document.createTextNode(String(child))
        );
    }

    function el(tag, props) {
        // An element rather than a tag name fills what is already there: a container Desmos
        // handed us gets built up the same way one of ours does, nulls skipped and all.
        var node = typeof tag === "string" ? document.createElement(tag) : tag;
        var settings = props || {};
        Object.keys(settings).forEach(function (key) {
            var value = settings[key];
            if (value === null || value === undefined) return;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "children") append(node, value);
            // onclick, oninput, ... - a listener rather than an inline-handler attribute, so that
            // several can be attached to the same node and none of them are strings.
            else if (key.slice(0, 2) === "on" && typeof value === "function")
                node.addEventListener(key.slice(2), value);
            // checked / disabled / hidden only mean anything as properties; the rest are markup.
            else if (typeof value === "boolean") node[key] = value;
            else node.setAttribute(key, value);
        });
        for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
        return node;
    }

    var sheets = {};

    function css(key, text) {
        if (sheets[key]) return;
        sheets[key] = true;
        var style = document.createElement("style");
        style.setAttribute("data-desmos-ext", key);
        style.textContent = text;
        (document.head || document.documentElement).appendChild(style);
    }

    // ---------------------------------------------------------------------------
    // which extensions are on
    // ---------------------------------------------------------------------------

    function stored() {
        try {
            return JSON.parse(g.localStorage.getItem(config.storage)) || {};
        } catch (e) {
            return {};
        }
    }

    // Switches the user has flipped this visit, id -> bool. Not written anywhere: apply() is
    // what makes a draft real, and until then the stored set is whatever it already was.
    var draft = {};

    // Whether the toggles have been unlocked for editing despite ?ext= deciding this load.
    var unlockedToggles = false;

    // ...and the same for the ones the open graph requires, which lock separately: ?ext= and
    // a graph are different claims on the same switches, and neither implies the other.
    var unlockedRequired = false;

    function required(entry) {
        return !!entry && !!entry.byGraph;
    }

    function hasRequired() {
        return catalog.some(required);
    }

    function has(id) {
        return Object.prototype.hasOwnProperty.call(draft, id);
    }

    /** Whether `id` is meant to be running - what its toggle shows, not what is loaded. */
    function enabled(id) {
        var entry = byId[id];
        if (!entry || !entry.supported) return false;
        if (entry.forced) return true;
        if (has(id)) return draft[id];
        // ?ext= is the whole answer while it is there, so the toggles report the load itself.
        if (config.overridden) return entry.active;
        // So is the graph, for the ones it names: the switch shows what is running, and
        // moving it is how someone disagrees.
        if (entry.byGraph) return true;
        var choice = stored()[id];
        return choice === undefined ? !!entry["default"] : !!choice;
    }

    function locked(id) {
        var entry = byId[id];
        if (!entry || !entry.supported || entry.forced) return true;
        if (required(entry) && !unlockedRequired) return true;
        return !!config.overridden && !unlockedToggles;
    }

    var listeners = [];

    function onDirty(fn) {
        listeners.push(fn);
        return function () {
            listeners = listeners.filter(function (one) {
                return one !== fn;
            });
        };
    }

    function announce() {
        listeners.slice().forEach(function (fn) {
            try {
                fn();
            } catch (error) {
                console.error("desmos: ui listener failed", error);
            }
        });
    }

    function setEnabled(id, on) {
        if (locked(id)) return false;
        draft[id] = !!on;
        announce();
        return true;
    }

    /** Let the toggles be edited even though ?ext= is what decided this load. */
    function unlock() {
        if (unlockedToggles || !config.overridden) return false;
        unlockedToggles = true;
        announce();
        return true;
    }

    /** The same, for the switches the open graph is holding down. */
    function unlockRequired() {
        if (unlockedRequired || !hasRequired()) return false;
        unlockedRequired = true;
        announce();
        return true;
    }

    /** Forget any argument with the graph and lock its switches again. */
    function resetRequired() {
        if (!hasRequired()) return false;
        catalog.forEach(function (entry) {
            if (required(entry)) delete draft[entry.id];
        });
        unlockedRequired = false;
        announce();
        return true;
    }

    /** Is the page out of date - is something toggled on that isn't running, or vice versa? */
    function dirty() {
        return catalog.some(function (entry) {
            return enabled(entry.id) !== entry.active;
        });
    }

    function reload() {
        g.location.reload();
    }

    /** The graph asked for these, and the toggles now say no to at least one of them. */
    function refusingGraph() {
        return catalog.some(function (entry) {
            return entry.byGraph && !enabled(entry.id);
        });
    }

    /**
     * Make the toggles the answer: write down every one of them - not just the flipped ones,
     * since a ?ext= load may never have agreed with what was stored - and come back up on it.
     *
     * ?ext= goes, because it would win again and none of this would have meant anything. So
     * does the open graph's list, but only if one of the toggles has actually turned it down,
     * and only for that graph - a list nobody argued with is left to keep working.
     */
    function apply() {
        var choices = stored();
        catalog.forEach(function (entry) {
            // Forced ones have no say, and an extension this calculator cannot run must keep
            // whatever it is set to for the calculators that can.
            if (entry.forced || !entry.supported) return;
            choices[entry.id] = enabled(entry.id);
        });
        try {
            g.localStorage.setItem(config.storage, JSON.stringify(choices));
            if (config.graph && refusingGraph())
                g.localStorage.setItem(
                    config.overrideStorage + config.graph,
                    "true"
                );
        } catch (e) {
            /* private browsing - the choice just doesn't stick */
        }

        var url = new URL(g.location.href);
        if (!url.searchParams.has("ext")) return reload();
        url.searchParams.delete("ext");
        g.location.replace(url.toString());
    }

    /** Let this graph have its extensions back. */
    function restoreGraph() {
        if (!config.graph) return false;
        try {
            g.localStorage.removeItem(config.overrideStorage + config.graph);
        } catch (e) {
            return false;
        }
        reload();
        return true;
    }

    // ---------------------------------------------------------------------------
    // slots - a named mount point one extension offers and another fills
    // ---------------------------------------------------------------------------

    var slots = {};
    // The elements currently mounted, and how to tear each one down. A slot may be filled
    // before its renderer registers (Desmos decides when it mounts), so these are kept either
    // way and drawn as soon as there is something to draw.
    var mounted = [];

    function draw(record) {
        var render = slots[record.name];
        if (!render || record.teardown !== null) return;
        record.teardown = undefined;
        try {
            var teardown = render(record.root, record.data);
            record.teardown =
                typeof teardown === "function" ? teardown : undefined;
        } catch (error) {
            record.teardown = undefined;
            console.error(
                'desmos: could not draw the "' + record.name + '" slot',
                error
            );
        }
    }

    function slot(name, render) {
        slots[name] = render;
        mounted.forEach(function (record) {
            if (record.name === name) draw(record);
        });
    }

    function mount(name, root, data) {
        var record = { name: name, root: root, data: data, teardown: null };
        mounted.push(record);
        draw(record);
        return root;
    }

    function unmount(root) {
        mounted = mounted.filter(function (record) {
            if (record.root !== root) return true;
            if (record.teardown) {
                try {
                    record.teardown();
                } catch (error) {
                    console.error(
                        'desmos: the "' +
                            record.name +
                            '" slot failed to tear down',
                        error
                    );
                }
            }
            return false;
        });
    }

    // ---------------------------------------------------------------------------
    // per-extension panels
    // ---------------------------------------------------------------------------

    // id -> the ui() hook it declared, with its setup() data already bound. Only extensions
    // that are actually running have one, which is the point: a panel is a live extension's
    // own settings, not a description of one that isn't there.
    var panels = {};

    function panel(id, render, data) {
        panels[id] = function (root) {
            return render(root, data);
        };
    }

    function renderPanel(id, root) {
        if (!panels[id]) return;
        try {
            panels[id](root);
        } catch (error) {
            console.error(
                'desmos: extension "' + id + '" could not draw its settings',
                error
            );
        }
    }

    ext.ui = {
        el: el,
        css: css,

        list: function () {
            return catalog.slice();
        },
        get: function (id) {
            return byId[id];
        },
        enabled: enabled,
        locked: locked,
        setEnabled: setEnabled,
        overridden: function () {
            return !!config.overridden;
        },
        unlock: unlock,
        unlocked: function () {
            return unlockedToggles;
        },
        dirty: dirty,
        onDirty: onDirty,
        apply: apply,
        reload: reload,

        wantedByGraph: function () {
            return (config.wantedByGraph || []).slice();
        },
        hasRequired: hasRequired,
        unlockRequired: unlockRequired,
        requiredUnlocked: function () {
            return unlockedRequired;
        },
        resetRequired: resetRequired,
        ignoringGraph: function () {
            return !!config.ignoringGraph;
        },
        restoreGraph: restoreGraph,

        slot: slot,
        mount: mount,
        unmount: unmount,

        panel: panel,
        hasPanel: function (id) {
            return Object.prototype.hasOwnProperty.call(panels, id);
        },
        renderPanel: renderPanel
    };
}
