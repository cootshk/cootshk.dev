// The Saved Graphs tab: what a graph is called, who wrote it, and the two ways out of here -
// a .dcg file on disk, or a snapshot link on Desmos' own servers.
//
// This one is not a tab we add. "my-graphs" is Desmos' own first tab, and logged out it is a
// sign-up pitch for an account this site cannot give anyone - so ../index.js is told the id
// and takes the body over, leaving Desmos' heading where it is.
//
// A tab of the settings extension; ../index.js owns the registry this hands itself to, and
// the patches that give the tab somewhere to be.
(function () {
    /** What a graph is called when nobody has said. */
    var UNTITLED = "Untitled Graph";

    /** The folder the metadata is kept in, on the graph itself. */
    var FOLDER = ".dcg";

    /** The magic a .dcg file starts with, before the calculator id and the gzipped body. */
    var MAGIC = "DCG";

    /** How long to wait out a burst of graph edits before redrawing the thumbnail. */
    var THUMBNAIL_DELAY = 400;

    /**
     * What this tab's graph observer is filed under. Desmos' unobserveEvent takes an event
     * name and not a callback, so an un-namespaced "change" would take every other
     * extension's observer down with ours - desmosMd watches the same event.
     */
    var WATCH = "change.cdeSavedGraphs";

    Extensions.settings.tab({
        key: "savedGraphs",
        // Desmos' own id for the tab, which is what makes this a takeover rather than an
        // addition: no heading of ours, no label, just the body.
        id: "my-graphs",
        render: savedGraphsTab
    });

    // -----------------------------------------------------------------------
    // the metadata, and where it lives on the graph
    // -----------------------------------------------------------------------

    /**
     * The metadata object, from what is in the fields. Everything with nothing to say is
     * left out, so a graph nobody described is `{"name":"Untitled Graph"}` and not four
     * empty strings and an empty list.
     */
    function metadata(fields, plugins) {
        var meta = { name: fields.name.value.trim() || UNTITLED };
        ["author", "description", "version"].forEach(function (key) {
            var value = fields[key].value.trim();
            if (value) meta[key] = value;
        });
        var forced = plugins
            .filter(function (one) {
                return one.box.checked;
            })
            .map(function (one) {
                return one.id;
            });
        if (forced.length) meta.forcePlugins = forced;
        return meta;
    }

    /** The metadata a note in the .dcg folder carries, unwrapped. */
    function readNote(text) {
        try {
            var note = JSON.parse(text);
            if (!note) return null;
            // Early graphs wrote the metadata as a string of JSON rather than as an object.
            // Reading both costs a line and saves anyone who has one of those.
            var meta =
                typeof note.metadata === "string"
                    ? JSON.parse(note.metadata)
                    : note.metadata;
            return meta && typeof meta === "object" && !Array.isArray(meta)
                ? meta
                : null;
        } catch (error) {
            return null; // a note that happens to start with a brace is still just a note
        }
    }

    /** The text of a metadata note: the metadata under a `metadata` key, as JSON. */
    function writeNote(meta) {
        return JSON.stringify({ metadata: meta });
    }

    /** The .dcg folder in an expression list, and the metadata note in it, if either is there. */
    function findFolder(list) {
        var folder = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].type === "folder" && list[i].title === FOLDER) {
                folder = { folder: list[i], at: i, note: null, noteAt: -1 };
                break;
            }
        }
        if (!folder) return null;
        for (var j = 0; j < list.length; j++) {
            var item = list[j];
            if (
                item.type === "text" &&
                item.folderId === folder.folder.id &&
                readNote(item.text || "")
            ) {
                folder.note = item;
                folder.noteAt = j;
                break;
            }
        }
        return folder;
    }

    /** The metadata already on the graph, or null. */
    function storedMetadata() {
        var list = (Calc.getState().expressions || {}).list || [];
        var found = findFolder(list);
        return found && found.note ? readNote(found.note.text || "") : null;
    }

    /** An id no expression in `list` is using. */
    function freshId(list, seed) {
        var taken = {};
        list.forEach(function (item) {
            taken[item.id] = true;
        });
        var n = 1;
        while (taken[seed + n]) n++;
        return seed + n;
    }

    /**
     * Put `meta` on the graph, in a hidden folder at the end of the expression list. A .dcg
     * folder that is already there is written into where it stands rather than moved - the
     * note may be any line in it - so a graph that has been saved before does not shuffle
     * every time.
     *
     * `allowUndo` keeps this one step on the undo stack instead of a state the user cannot
     * get back from.
     */
    function writeMetadata(meta) {
        var state = Calc.getState();
        var list = (state.expressions || {}).list;
        if (!list) return;

        var found = findFolder(list);
        if (found && found.note) {
            found.note.text = writeNote(meta);
        } else if (found) {
            // A .dcg folder without a metadata note: add one after whatever is in it, so it
            // lands inside the folder rather than after the folder's last sibling.
            var end = found.at + 1;
            while (end < list.length && list[end].folderId === found.folder.id)
                end++;
            list.splice(end, 0, {
                type: "text",
                id: freshId(list, "dcg-note-"),
                folderId: found.folder.id,
                text: writeNote(meta)
            });
        } else {
            var folderId = freshId(list, "dcg-folder-");
            list.push({
                type: "folder",
                id: folderId,
                title: FOLDER,
                // Desmos' own hidden folder flag - its geometry folder is secret the same
                // way. The folder stays out of the expression list unless the reader has
                // author features turned on.
                secret: true,
                collapsed: true
            });
            list.push({
                type: "text",
                id: freshId(list, "dcg-note-"),
                folderId: folderId,
                text: writeNote(meta)
            });
        }

        Calc.setState(state, { allowUndo: true });
    }

    // -----------------------------------------------------------------------
    // the file
    // -----------------------------------------------------------------------

    /** Which calculator this is, by the name extensions.json and ?type= use. */
    function calculatorId() {
        var product;
        try {
            product = Calc.controller.getProduct();
        } catch (error) {
            product = null;
        }
        return ((product && modeForProduct(product)) || mode).key;
    }

    /**
     * The undo stack, as JSON.
     *
     * Calc.getHistory() hands back an object whose toJSON() throws on purpose - Desmos does
     * not want this serialized - and keeps the stack itself on a symbol-keyed property.
     * Reading it is what Desmos' own restore-history action does, and the shape below is
     * what that action takes back, so a file written today can be restored later.
     *
     * A bundle that renames the symbol loses the history rather than the save.
     */
    function history() {
        try {
            var got = Calc.getHistory();
            var key = Object.getOwnPropertySymbols(got).filter(function (one) {
                return one.description === "privateHistoryProperty";
            })[0];
            return {
                currentState: got.currentState,
                history: key ? got[key] : undefined
            };
        } catch (error) {
            console.warn("desmos: couldn't read the graph history", error);
            return null;
        }
    }

    /** "DCG\0<calculator>\0" followed by the gzipped body. */
    function dcgFile(id, body) {
        var json = new Blob([JSON.stringify(body)]);
        return new Response(
            json.stream().pipeThrough(new CompressionStream("gzip"))
        )
            .arrayBuffer()
            .then(function (gzipped) {
                return new Blob(
                    [
                        new TextEncoder().encode(MAGIC + "\0" + id + "\0"),
                        gzipped
                    ],
                    { type: "application/octet-stream" }
                );
            });
    }

    /** A name a filesystem will take. */
    function filename(name) {
        var clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim();
        return (clean || UNTITLED) + ".dcg";
    }

    function download(blob, as) {
        var url = URL.createObjectURL(blob);
        // The loader catches link clicks to keep navigation on this page, but steps aside
        // for anything carrying a download attribute - see desmos.js.
        var link = window.__desmosExt.ui.el("a", { href: url, download: as });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 10000);
    }

    /**
     * Name the graph itself, which is a separate thing from the metadata: it is what the
     * title bar shows here, and what Desmos stores alongside a published graph, so a
     * snapshot opens under its name rather than as "Untitled Graph".
     *
     * A copy rather than a mutation, because the cache hands out the live object and Desmos
     * replaces rather than edits its own graphs. setCurrentGraph is what puts the name in
     * document.title; `true` keeps it off the address bar, since the graph has not moved.
     */
    function nameGraph(controller, name) {
        var graphs = controller && controller.graphsController;
        if (!graphs || !graphs.getCurrentGraph) return;
        var graph = graphs.getCurrentGraph();
        if (!graph || graph.title === name) return;
        graphs.setCurrentGraph(graph.copy({ title: name }), true);
        if (controller.triggerRender) controller.triggerRender();
    }

    // -----------------------------------------------------------------------
    // links
    // -----------------------------------------------------------------------

    /** Where a published graph lives upstream. */
    function desmosLink(hash) {
        var upstream = MODES[calculatorId()] || MODES.graphing;
        return "https://www.desmos.com/" + upstream.path + "/" + hash;
    }

    /**
     * Copy, by the clipboard if the page is allowed one and by the old selection trick if
     * not - which is what Desmos itself falls back to.
     */
    function copy(text) {
        if (navigator.clipboard && navigator.clipboard.writeText)
            return navigator.clipboard.writeText(text);
        return new Promise(function (resolve, reject) {
            var area = window.__desmosExt.ui.el("textarea", {
                style: "position:fixed;top:-1000px;opacity:0"
            });
            area.value = text;
            document.body.appendChild(area);
            area.select();
            try {
                if (document.execCommand("copy")) resolve();
                else reject(new Error("the browser refused to copy"));
            } catch (error) {
                reject(error);
            } finally {
                area.remove();
            }
        });
    }

    // -----------------------------------------------------------------------
    // the tab
    // -----------------------------------------------------------------------

    /** `controller` is the my-graphs modal's own controller, handed over by ../index.js. */
    function savedGraphsTab(root, controller) {
        var ui = window.__desmosExt.ui;

        var fields = {
            name: input("Name", UNTITLED, true),
            author: input("Author", "Anonymous"),
            description: null,
            version: input("Version", "1.0.0")
        };
        fields.description = ui.el("textarea", {
            class: "cde-saved__field cde-saved__field--text",
            rows: "3",
            placeholder: "What does this graph do?"
        });

        // Only what the user turned on: the two that are always on say nothing about a
        // graph, and one that is off is not there to force.
        var plugins = ui
            .list()
            .filter(function (entry) {
                return ui.enabled(entry.id) && !entry.forced;
            })
            .map(function (entry) {
                var box = ui.el("input", {
                    type: "checkbox",
                    class: "cde-saved__check"
                });
                return {
                    id: entry.id,
                    box: box,
                    node: ui.el(
                        "label",
                        { class: "cde-saved__plugin" },
                        box,
                        ui.el("span", { text: entry.name })
                    )
                };
            });

        var thumbnail = ui.el("img", {
            class: "cde-saved__thumbnail",
            alt: "Thumbnail of the current graph"
        });

        var status = ui.el("p", { class: "cde-saved__status", hidden: true });
        var save = button("Save", onSave);
        var publish = button("Publish", onPublish, true);
        var buttons = ui.el(
            "div",
            { class: "cde-saved__buttons" },
            save,
            publish
        );

        ui.el(
            root,
            null,
            ui.el(
                "div",
                { class: "cde-saved__fields" },
                titled("Name", fields.name),
                titled("Author", fields.author),
                titled("Description", fields.description),
                titled("Version", fields.version),
                plugins.length
                    ? ui.el(
                          "div",
                          { class: "cde-saved__group" },
                          ui.el("span", {
                              class: "cde-saved__title",
                              text: "Force plugins"
                          }),
                          ui.el(
                              "div",
                              { class: "cde-saved__plugins" },
                              plugins.map(function (one) {
                                  return one.node;
                              })
                          )
                      )
                    : null
            ),
            ui.el(
                "div",
                { class: "cde-saved__preview" },
                ui.el("span", {
                    class: "cde-saved__title",
                    text: "Thumbnail"
                }),
                thumbnail
            ),
            buttons,
            status
        );

        fill(storedMetadata());
        drawThumbnail();

        // The thumbnail is of the graph as it stands, so it follows the graph. A burst of
        // edits - dragging a slider - is one redraw.
        var timer = null;
        Calc.observeEvent(WATCH, function () {
            clearTimeout(timer);
            timer = setTimeout(drawThumbnail, THUMBNAIL_DELAY);
        });

        return function () {
            clearTimeout(timer);
            Calc.unobserveEvent(WATCH);
        };

        // --- the pieces ----------------------------------------------------

        function input(label, placeholder, required) {
            return ui.el("input", {
                class: "cde-saved__field",
                type: "text",
                placeholder: placeholder,
                "aria-label": label,
                required: !!required
            });
        }

        /** A field under a heading that names it and focuses it when tapped. */
        function titled(title, node) {
            return ui.el(
                "label",
                { class: "cde-saved__group" },
                ui.el("span", { class: "cde-saved__title", text: title }),
                node
            );
        }

        function button(text, onclick, primary) {
            return ui.el("button", {
                class:
                    "cde-theme__button" +
                    (primary ? " cde-theme__button--primary" : ""),
                type: "button",
                text: text,
                onclick: onclick
            });
        }

        function say(text, bad) {
            status.textContent = text;
            status.hidden = !text;
            status.className =
                "cde-saved__status" + (bad ? " cde-saved__status--error" : "");
        }

        /** Show what the graph already says about itself, if it says anything. */
        function fill(meta) {
            if (!meta) return;
            ["name", "author", "description", "version"].forEach(
                function (key) {
                    if (typeof meta[key] === "string")
                        fields[key].value = meta[key];
                }
            );
            var forced = Array.isArray(meta.forcePlugins)
                ? meta.forcePlugins
                : [];
            plugins.forEach(function (one) {
                one.box.checked = forced.indexOf(one.id) !== -1;
            });
        }

        function drawThumbnail() {
            try {
                var url = Calc.makeThumbnail();
                if (url) thumbnail.src = url;
            } catch (error) {
                // A calculator that cannot screenshot on demand - the 3D grapher, mid-frame -
                // keeps whatever was there rather than blanking.
                console.warn("desmos: couldn't draw the thumbnail", error);
            }
        }

        /** The metadata as the fields have it, written to the graph on the way past. */
        function commit() {
            var meta = metadata(fields, plugins);
            nameGraph(controller, meta.name);
            writeMetadata(meta);
            return meta;
        }

        // --- the buttons ---------------------------------------------------

        function onSave() {
            say("");
            var meta;
            try {
                meta = commit();
            } catch (error) {
                console.error(
                    "desmos: couldn't write the graph metadata",
                    error
                );
                say("Couldn't write the metadata to the graph.", true);
                return;
            }

            // After commit(), so the file carries the folder it just wrote - a .dcg that
            // has lost its metadata key still says what it is.
            dcgFile(calculatorId(), {
                graph: Calc.getState(),
                history: history(),
                metadata: meta
            })
                .then(function (blob) {
                    download(blob, filename(meta.name));
                    say("Saved " + filename(meta.name) + ".");
                })
                .catch(function (error) {
                    console.error(
                        "desmos: couldn't build the .dcg file",
                        error
                    );
                    say("Couldn't build the file.", true);
                });
        }

        /**
         * Desmos' own snapshot save - the one behind "share graph" - and then the two ways
         * of pointing at what it made.
         */
        function onPublish() {
            var graphs = controller && controller.graphsController;
            if (!graphs) {
                say("The graphs controller isn't there to publish with.", true);
                return;
            }

            say("Publishing...");
            publish.disabled = true;
            save.disabled = true;

            try {
                commit();
            } catch (error) {
                console.error(
                    "desmos: couldn't write the graph metadata",
                    error
                );
            }

            Promise.resolve(graphs.createSnapshotLink())
                .then(function () {
                    var graph = graphs.getLastSharedSnapshot();
                    if (!graph || !graph.hash)
                        throw new Error("no snapshot came back");
                    offer(graph);
                    say("");
                })
                .catch(function (error) {
                    console.error("desmos: couldn't publish the graph", error);
                    say("Couldn't publish the graph.", true);
                    publish.disabled = false;
                })
                .then(function () {
                    save.disabled = false;
                });
        }

        /**
         * The published graph is not going to change, so Publish has nothing left to do:
         * it becomes the two ways of pointing at what it made. Save stays - the file is
         * still worth having, and it now records the snapshot's own metadata.
         */
        function offer(graph) {
            // getURL() is patched by the core extension to answer with this site's address,
            // so the pair is upstream and here.
            var here = graph.getURL();
            var there = desmosLink(graph.hash);
            publish.replaceWith(
                button("Copy desmos.com link", function () {
                    hand(there);
                }),
                // The one that stays on this site is the one to reach for, so it keeps the
                // accent the Publish button had.
                button(
                    "Copy cootshk.dev link",
                    function () {
                        hand(here);
                    },
                    true
                )
            );
        }

        function hand(link) {
            copy(link).then(
                function () {
                    say("Copied " + link);
                },
                function (error) {
                    console.error("desmos: couldn't copy the link", error);
                    say(link, true);
                }
            );
        }
    }
})();
