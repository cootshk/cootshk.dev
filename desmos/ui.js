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
//   ui.setEnabled(id, on)              remember a choice. Takes effect on the next load.
//   ui.overridden()                    is ?ext= deciding instead, making toggles read-only?
//   ui.dirty()                         does what is toggled on differ from what is running?
//   ui.onDirty(fn) -> off              called when that answer may have changed.
//   ui.reload()                        reload the page, so that it doesn't.
//
//   ui.slot(name, render)              offer a named mount point. render(root) draws into a
//                                      fresh element and may return a teardown function.
//   ui.mount(name, root)               fill one. Patched Desmos code calls this from a
//                                      didMount, and a slot registered later still lands.
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

    /** Whether `id` is meant to be running - what its toggle shows, not what is loaded. */
    function enabled(id) {
        var entry = byId[id];
        if (!entry || !entry.supported) return false;
        if (entry.forced) return true;
        // ?ext= is the whole answer while it is there, so the toggles report the load itself.
        if (config.overridden) return entry.active;
        var choice = stored()[id];
        return choice === undefined ? !!entry["default"] : !!choice;
    }

    function locked(id) {
        var entry = byId[id];
        return (
            !entry || !entry.supported || entry.forced || !!config.overridden
        );
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

    function setEnabled(id, on) {
        if (locked(id)) return false;
        var choices = stored();
        choices[id] = !!on;
        try {
            g.localStorage.setItem(config.storage, JSON.stringify(choices));
        } catch (e) {
            /* private browsing - the choice just doesn't stick */
        }
        listeners.slice().forEach(function (fn) {
            try {
                fn();
            } catch (error) {
                console.error("desmos: ui listener failed", error);
            }
        });
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
            var teardown = render(record.root);
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

    function mount(name, root) {
        var record = { name: name, root: root, teardown: null };
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
        dirty: dirty,
        onDirty: onDirty,
        reload: reload,

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
