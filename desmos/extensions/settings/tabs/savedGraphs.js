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

    // The file format itself is read by the loader, which has to understand a .dcg before
    // any of this is running: DCG_MAGIC, readDcg() and holdUpload() are all desmos.js', and
    // in scope here the same way `mode` and `MODES` are. This file only writes them.

    /** What the upload button says whenever it is not busy. */
    var UPLOAD_LABEL = "Upload Graph";

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
        render: savedGraphsTab,

        // The other half of the modal we have a hand in: the Upload Graph button beside
        // "New Graph", whose place ../index.js patches in.
        main: function () {
            var ext = window.__desmosExt;
            ext.ui.slot("cde-upload", uploadButton);
            // A file uploaded on the last page load, waiting for a calculator to go into.
            if (ext.upload)
                ext.onCalc(function () {
                    applyUpload(ext.upload);
                    ext.upload = null;
                });
        }
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

    /**
     * An id Desmos has not used and will not use again.
     *
     * Its own counter only ever goes up, so an id freed by deleting an expression is still
     * spoken for - picking the lowest one nothing currently holds would hand back an id the
     * calculator still considers taken. Ask the calculator instead, and only fall back to
     * counting if that ever stops being a thing.
     */
    function freshId(list) {
        try {
            var id = Calc.controller.generateId();
            if (id) return String(id);
        } catch (error) {
            /* fall through to counting */
        }
        var taken = {};
        list.forEach(function (item) {
            taken[item.id] = true;
        });
        var n = list.length;
        while (taken["dcg-" + n]) n++;
        return "dcg-" + n;
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
        var folder;
        var inside;

        if (found) {
            // Lift the folder and everything in it out of where it stands. A graph that has
            // been saved before has grown since, and the folder is only at the end of the
            // sheet if it is put back there.
            folder = found.folder;
            var end = found.at + 1;
            while (end < list.length && list[end].folderId === folder.id) end++;
            inside = list.splice(found.at, end - found.at).slice(1);
        } else {
            folder = {
                type: "folder",
                id: freshId(list),
                title: FOLDER,
                // Desmos' own hidden folder flag - its geometry folder is secret the same
                // way. The folder stays out of the expression list unless the reader has
                // author features turned on.
                secret: true,
                collapsed: true
            };
            inside = [];
        }

        var note = inside.filter(function (item) {
            return item.type === "text" && readNote(item.text || "");
        })[0];
        if (note) {
            note.text = writeNote(meta);
        } else {
            inside.push({
                type: "text",
                id: freshId(list),
                folderId: folder.id,
                text: writeNote(meta)
            });
        }

        // Last, and in one piece: the folder owns the run of items that follows it.
        list.push(folder);
        inside.forEach(function (item) {
            item.folderId = folder.id;
            list.push(item);
        });

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
                        new TextEncoder().encode(DCG_MAGIC + "\0" + id + "\0"),
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
    // reading one back
    // -----------------------------------------------------------------------

    /**
     * Put the undo stack back.
     *
     * Desmos will only take its own history object, and what identifies one is a symbol and
     * a prototype - neither of which survives JSON. Both can be borrowed from the history
     * the calculator already has, which is what this does. Worth a try and not worth a
     * failed load: the graph itself is already in by the time this runs.
     */
    function restoreHistory(saved) {
        if (!saved || !saved.history || !saved.currentState) return false;
        try {
            var live = Calc.getHistory();
            var key = Object.getOwnPropertySymbols(live).filter(function (one) {
                return one.description === "privateHistoryProperty";
            })[0];
            if (!key) return false;

            var stack = Object.create(Object.getPrototypeOf(live[key]));
            Object.keys(saved.history).forEach(function (name) {
                stack[name] = saved.history[name];
            });

            var history = Object.create(Object.getPrototypeOf(live));
            history.currentState = saved.currentState;
            Object.defineProperty(history, key, {
                value: stack,
                enumerable: false
            });

            Calc.restoreHistory(history);
            return true;
        } catch (error) {
            console.warn("desmos: couldn't restore the graph history", error);
            return false;
        }
    }

    /**
     * Put an uploaded file into the calculator. Runs once, at startup, on the load that the
     * upload itself asked for - by which point the extensions it named are already running,
     * which is the whole reason opening one is a page load.
     */
    function applyUpload(upload) {
        var body = (upload && upload.body) || {};
        if (!body.graph) {
            console.error("desmos: the uploaded file has no graph in it");
            return;
        }
        try {
            Calc.setState(body.graph);
            restoreHistory(body.history);

            var meta = body.metadata || {};
            // window.shellController is Desmos' own global, and the only way to the graph's
            // name from out here - the modal, which hands its controller to the tab, may
            // never have been opened.
            if (meta.name) nameGraph(window.shellController, meta.name);
        } catch (error) {
            console.error("desmos: couldn't open the uploaded graph", error);
        }
    }

    /** Extensions a file asks for that this page is not running. */
    function missingPlugins(meta) {
        var ui = window.__desmosExt.ui;
        var wanted =
            meta && Array.isArray(meta.forcePlugins) ? meta.forcePlugins : [];
        return wanted
            .map(function (one) {
                return String(one).split("@")[0];
            })
            .filter(function (id) {
                var entry = ui.get(id);
                return !entry || !entry.active;
            });
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
    // the Upload Graph button
    // -----------------------------------------------------------------------

    /**
     * Beside "New Graph", in Desmos' own outline-button style so the two match. `controller`
     * is the modal's, handed over by ../index.js.
     */
    function uploadButton(root, controller) {
        var ui = window.__desmosExt.ui;

        var file = ui.el("input", {
            type: "file",
            // A hint for the picker, not a guarantee - the bytes are checked either way.
            accept: ".dcg",
            class: "cde-upload__file",
            onchange: function () {
                var chosen = file.files && file.files[0];
                // Cleared, so choosing the same file twice in a row still counts.
                file.value = "";
                if (chosen) open(chosen);
            }
        });

        var button = ui.el("button", {
            class: "dcg-btn-gray-outline cde-upload__button",
            type: "button",
            text: UPLOAD_LABEL,
            onclick: function () {
                file.click();
            }
        });

        ui.el(root, null, button, file);

        function say(text) {
            button.textContent = text;
        }

        /**
         * Opening a file is a page load, the same as opening an example: the extensions it
         * asks for are chosen before the calculator starts, so there is no opening one
         * properly without going round again. The file is checked here - a reload that
         * landed on a broken one would have nothing left to report it with - then held for
         * the next load to pick up.
         */
        function open(chosen) {
            say("Opening...");
            chosen
                .arrayBuffer()
                .then(function (buffer) {
                    return readDcg(buffer).then(function (read) {
                        if (!read.body || !read.body.graph)
                            throw new Error("there is no graph in it");

                        // A file written for another calculator opens in that one, which is
                        // what Desmos does with an example belonging elsewhere.
                        var to = MODES[read.id] || mode;

                        return holdUpload(new Uint8Array(buffer)).then(
                            function () {
                                // No graph named: the address has to stop pointing at the
                                // one being left, and an upload has no address of its own.
                                navigateTo(to, undefined);
                            },
                            function (error) {
                                // Nothing wrong with the file - it just cannot be carried
                                // across the reload. Opening it here loses the extensions it
                                // asks for and nothing else, which beats not opening it.
                                console.warn(
                                    "desmos: couldn't hold the upload across a reload",
                                    error
                                );
                                inPlace(read);
                            }
                        );
                    });
                })
                .catch(function (error) {
                    console.error("desmos: couldn't open the .dcg file", error);
                    // Nothing was opened, so the button goes back to what it said rather
                    // than staying behind to report it.
                    say(UPLOAD_LABEL);
                    alert("Not a valid Desmos graph!");
                });
        }

        /** Open it here and now, for when it cannot be carried across a reload. */
        function inPlace(read) {
            var here = calculatorId();
            if (read.id && read.id !== here) {
                // Nothing wrong with the file - it is for another calculator, and going
                // there is exactly the trip it could not be carried on.
                say(UPLOAD_LABEL);
                alert(
                    "That graph is for the " +
                        read.id +
                        " calculator, and it couldn't be sent there."
                );
                return;
            }

            applyUpload(read);

            var missing = missingPlugins(read.body.metadata);
            if (missing.length)
                console.warn(
                    "desmos: this graph asks for " +
                        missing.join(", ") +
                        ", which " +
                        (missing.length === 1 ? "is" : "are") +
                        " not running"
                );

            // Out of the way, so the graph that was just opened can be seen.
            if (controller && controller.dispatch)
                controller.dispatch({ type: "close-modal" });
            say(UPLOAD_LABEL);
        }
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
