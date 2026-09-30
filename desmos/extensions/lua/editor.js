// The box you type a cell into, and the chrome around it.
//
// One Monaco editor per cell, built when the row appears and thrown away when it goes. This
// used to be a single editor moved into whichever cell had focus, with the others showing a
// <pre> coloured by monaco.editor.colorize - cheaper, and wrong twice over:
//
//   - focusing a cell replaced the very element the click had landed on, so the click did not
//     reach the editor and it took several to get in;
//   - and leaving a cell rebuilt its box from `cell.source`, which turned every bug anywhere
//     near that value into the cell's text visibly vanishing.
//
// A row that scrolls out of the expression list is unmounted by Desmos, so the number of live
// editors is bounded by what is on screen rather than by how many cells the graph has. The text
// is never re-derived from anything: the Monaco model *is* the text, it outlives the row, and
// nothing repaints on focus.
//
// Until Monaco arrives - or for good, if it never does - a cell is a textarea. That is worth
// keeping for the reason extensions/settings/tabs/themes.js keeps it: a cell you cannot edit is
// a cell you cannot empty, and nothing here should need a CDN to be fixable. Running does not
// depend on Monaco at all; only the colours and the error markers do.
//
// Monaco itself is ../../monaco.js, shared with that tab and asked for as soon as this
// extension starts rather than when the first cell is drawn - a cell drawn before it answers
// is the textarea above, and it is replaced when it does.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    /** Kept in step with index.css. */
    var FONT = 13;
    var LINE = 20;
    var PAD = 12;

    /** Past this the box scrolls rather than growing without end. */
    var MAX_HEIGHT = 480;

    /** Monaco, once ../../monaco.js has it. Null until then, and forever if it never does. */
    var api = null;

    /** Our end of that load, so a second cell being drawn does not ask again. */
    var loading = null;

    /** expr-id -> the editor in that row, while the row exists. */
    var editors = new Map();

    /** expr-id -> Monaco model. Outlives the row, so scrolling costs no undo history. */
    var models = new Map();

    /** expr-id -> the stand-in in the copy Desmos drags, for as long as a drag lasts. */
    var ghosts = new Map();

    /** A cell to focus as soon as its row turns up - the freshly created one. */
    var pending = null;

    /** Rows we have already bound keys on, so a re-render does not stack another listener. */
    var bound = new WeakSet();

    var Calc = null;
    var ui = null;

    lua.editor = {
        init: init,
        attach: attach,
        ghost: ghost,
        detach: detach,
        refresh: refresh,
        render: render,
        forget: forget,
        focusSoon: function (id) {
            pending = id;
        }
    };

    function init(calc) {
        Calc = calc;
        ui = window.__desmosExt.ui;

        // Monaco is ../../monaco.js' copy, shared with the Themes tab, so it may be here
        // already - in which case take it now, and the first cell is an editor rather than a
        // textarea that turns into one a second later. If it is not, ask for it here rather
        // than when the first cell is drawn: a cell is what this extension is for, so the
        // wait is better spent while the graph is still opening than in front of someone
        // who has just made one.
        var shared = window.__desmosExt.monaco;
        if (shared.api()) arrive(shared.api());
        else want();
    }

    // -----------------------------------------------------------------------
    // a cell's row
    // -----------------------------------------------------------------------

    /**
     * Give `cell` its box inside `node`, its row. Called again on a row it already owns - the
     * virtualizer rebuilds rows as it scrolls, and React drops anything we put on them - so
     * everything here is written to be idempotent.
     */
    function attach(cell, node) {
        if (cell.node === node && node.contains(cell.host)) {
            // Still ours, but the gutter button is a child of a tab React owns, so it is checked
            // again rather than assumed - gutter() puts one back only if there is none.
            gutter(cell, node);
            take(cell);
            return;
        }

        // A different row, or the same row rebuilt without what we put in it. Either way the
        // last box goes before another is made: a cell has one, and two would mean an editor
        // left running in a node nobody can reach and a dark empty box stacked above the one
        // being typed in. detach() keeps the model, so neither the text nor its undo history
        // is in this - only the keyboard, which is put back where it was.
        var held = !!(
            cell.host &&
            document.activeElement &&
            cell.host.contains(document.activeElement)
        );
        if (cell.host || cell.node) detach(cell);

        node.setAttribute("data-cde-lua", "");
        keys(cell, node);
        guard(cell, node);
        gutter(cell, node);

        var anchor = node.querySelector(".dcg-displayTextarea");
        var parent = anchor ? anchor.parentNode : node;

        cell.node = node;
        cell.host = build(cell);
        inset(cell.host, anchor);
        if (anchor && anchor.nextSibling)
            parent.insertBefore(cell.host, anchor.nextSibling);
        else parent.appendChild(cell.host);

        mount(cell);
        render(cell);
        take(cell);
        if (held) enter(cell);
    }

    /**
     * The same box again, in the copy of the row Desmos drags under the cursor.
     *
     * A row being dragged is on the page twice: the row, which stays where it is, and a second
     * view of the same item inside `.dcg-drag-container` that follows the pointer. The cell's
     * own box belongs to the row - it is where the keyboard and the undo history are, and a
     * box cannot be in two places - so the copy gets a stand-in of its own: another editor
     * over the same model, readOnly and unreachable. Without it a dragged cell turns back into
     * the note it is made of for as long as it is held, and into a cell again when dropped.
     *
     * Sharing the model is what makes it the same box rather than something that looks like
     * it: the same text, the same colours, the same error squiggles, all without a copy of
     * anything that could drift. Monaco is built for several editors over one model, and
     * disposing one of them leaves the model alone.
     *
     * `node` is that copy, or null for "the drag is over" - paint() says so for every cell
     * that did not have one this pass, so a ghost cannot outlive the container it was drawn
     * in. Nothing here is written to `cell`: a ghost is not the cell's row, and the two must
     * never be able to take each other's box.
     */
    function ghost(cell, node) {
        var found = ghosts.get(cell.id);
        if (found && found.node === node && node.contains(found.host)) return;

        if (found) {
            ghosts.delete(cell.id);
            if (found.editor) found.editor.dispose();
            if (found.host.parentNode)
                found.host.parentNode.removeChild(found.host);
        }
        if (!node) return;

        // Same as a row's: the note's own text goes, the note's own icon stands down.
        node.setAttribute("data-cde-lua", "");

        var box = ui.el("div", { class: "cde-lua__box" });
        var host = ui.el("div", { class: "cde-lua cde-lua__ghost" }, box);
        var anchor = node.querySelector(".dcg-displayTextarea");
        var parent = anchor ? anchor.parentNode : node;
        inset(host, anchor);
        if (anchor && anchor.nextSibling)
            parent.insertBefore(host, anchor.nextSibling);
        else parent.appendChild(host);

        // The run button as the row has it this moment - a still of it, cloned, so none of its
        // listeners and none of the tooltip behind its error form come along.
        var tab = node.querySelector("span.dcg-tab");
        var slot = tab && (tab.querySelector(".dcg-tab-interior") || tab);
        if (slot && cell.icon && !slot.querySelector(".cde-lua__icon"))
            slot.appendChild(cell.icon.cloneNode(true));

        var kept = { node: node, host: host, editor: null };
        ghosts.set(cell.id, kept);

        // No Monaco: the row is a textarea, so this is one too, and the two still match.
        if (!api) {
            var still = ui.el("textarea", {
                class: "cde-lua__plain",
                readonly: "readonly",
                tabindex: "-1",
                "aria-hidden": "true",
                spellcheck: "false",
                wrap: "off"
            });
            still.value = cell.source;
            still.style.height = tall(cell.source) + "px";
            box.appendChild(still);
            return;
        }

        // Sized before the editor is made rather than after: Monaco measures its container on
        // the way up, and a box of no height is an editor that draws nothing. The line count
        // is what both tall() and grown() are counting, so the second is a correction and
        // rarely a change.
        box.style.height = tall(cell.source) + "px";
        kept.editor = api.editor.create(box, {
            model: model(cell),
            theme: "vs-dark",
            // Nothing can be typed, clicked or scrolled in a ghost, so the parts that only
            // answer to a caret are off. The rest is mount()'s, because the point is to be
            // indistinguishable from the box it stands in for.
            readOnly: true,
            domReadOnly: true,
            // Monaco hides a readOnly editor's squiggles unless told otherwise - the default
            // is "editable" - and a cell with an error in it should still have one here.
            renderValidationDecorations: "on",
            automaticLayout: true,
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            scrollbar: { vertical: "hidden", horizontal: "hidden" },
            renderLineHighlight: "none",
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            folding: false,
            wordWrap: "off",
            fontSize: FONT,
            lineHeight: LINE,
            padding: { top: 6, bottom: 6 }
        });
        box.style.height = grown(kept.editor) + "px";
    }

    /**
     * Desmos' own textarea for the row is where it hands the keyboard when it means to focus
     * the row - that is what makes Tab and typing over a selected row work - but it also still
     * holds the note's text. Left writable, anything typed while the row is focused is spliced
     * into it by Desmos' own note editing, and scan() then faithfully carries it into the code
     * box.
     *
     * Read-only on the element, not on Desmos' model: the browser refuses text, while focus,
     * caret movement and every key Desmos binds still behave. `keys` below is what a typed
     * character is *for* - this is the backstop for everything it does not catch, a paste
     * included. Re-applied because React rebuilds rows and would drop it.
     */
    function guard(cell, node) {
        var area =
            (node || cell.node) &&
            (node || cell.node).querySelector("textarea.dcg-smart-textarea");
        if (area && !area.readOnly) area.readOnly = true;
    }

    /**
     * The keys that belong to the row rather than to the editor.
     *
     * Bound on the row, not on our box: the two things that can hold the keyboard when the
     * editor does not are Desmos' item container and the note's textarea, and both are inside
     * the row and outside the box. An event that came from inside the box is the editor's own -
     * Tab there indents, and letters are already going where they should.
     *
     *   Tab         put the caret at the end of the code, as Tab does over an expression
     *   a printable go into the code and type it, the way typing on an expression's row starts
     *               editing it
     *
     * Everything else is left alone, so Enter still makes a line below and Backspace still
     * deletes the row - both Desmos', both already right.
     *
     * And the same two keys again, from the other side. Over a row that is selected rather
     * than being edited - after an Escape, or an arrow from the row above - Desmos answers
     * Tab and a printable itself, by focusing the row: `move-focus-to-item`, which for a note
     * is its textarea. There is nothing there for either key to do, so the focus is caught
     * below and passed on to the editor. The keystroke is still in flight when that happens -
     * the character lands wherever the keyboard is by the time the browser delivers it - so
     * the letter that started it arrives in the code by itself.
     */
    function keys(cell, node) {
        if (bound.has(node)) return;
        bound.add(node);

        node.addEventListener("focusin", function (event) {
            var target = event.target;
            if (!target || !target.matches) return;
            if (!target.matches("textarea.dcg-smart-textarea")) return;

            var live = lua.cell(cell.id);
            if (!live || !live.host) return;
            enter(live);
        });

        node.addEventListener("keydown", function (event) {
            if (event.ctrlKey || event.metaKey || event.altKey) return;

            var live = lua.cell(cell.id);
            if (!live || !live.host) return;
            if (live.host.contains(event.target)) return;

            if (event.key === "Tab") {
                if (event.shiftKey) return;
                event.preventDefault();
                event.stopPropagation();
                enter(live);
                return;
            }

            // One character's worth of key: a letter, a digit, punctuation, a space. Enter, the
            // arrows and the rest report longer names and are not ours.
            if (event.key && event.key.length === 1) {
                event.preventDefault();
                event.stopPropagation();
                enter(live);
                type(live, event.key);
            }
        });
    }

    /**
     * Type `text` into the cell, as if it had been typed in the editor.
     *
     * The keystroke that brought us here was cancelled - the editor did not have the keyboard
     * when it happened - so the character has to be put in by hand rather than left to arrive.
     */
    function type(cell, text) {
        var editor = editors.get(cell.id);
        if (editor) {
            editor.trigger("cde-lua", "type", { text: text });
            return;
        }

        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (!input) return;
        // enter() has already put the caret at the end.
        input.value += text;
        input.style.height = tall(input.value) + "px";
        lua.edited(cell.id, input.value);
    }

    /** Put the keyboard in the cell's code, caret at the end. */
    function enter(cell) {
        var editor = editors.get(cell.id);
        if (editor) {
            var model = editor.getModel();
            if (model) {
                var line = model.getLineCount();
                var at = {
                    lineNumber: line,
                    column: model.getLineMaxColumn(line)
                };
                editor.setPosition(at);
                editor.revealPositionInCenterIfOutsideViewport(at);
            }
            editor.focus();
            return;
        }

        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    /**
     * The run button, where the note's own icon was.
     *
     * Built out of Desmos' own classes rather than styled from scratch, because an action's run
     * button is the thing it is meant to look like and there is no reason to guess at 29px and
     * the theme's outline colour when the calculator will say. Running a cell is the nearest
     * thing the sheet already has a button for, and `a\to a+1` wears this one. Desmos' chain,
     * with its tooltip and popover wrappers - which are components, and not reachable from
     * markup - left out:
     *
     *     span.dcg-tab                                <- Desmos', the note row's
     *       div.dcg-tab-interior                      <- Desmos', empty in a note
     *         div.dcg-expression-icon-container        (absolute, 29px, centred in the tab)
     *           div.dcg-action-icon-view               (what centres the button in that 29px)
     *             div.dcg-circular-icon-container
     *               span.dcg-circular-icon.dcg-thick-outline  (the ring: 2px, themed, 50%)
     *                 i.dcg-icon-minus                        (the arrow's stem)
     *                 i.dcg-icon-chevron-right                (and its head)
     *
     * `dcg-action-icon-view` is not decoration: it is the layer Desmos centres the circle in,
     * and without it the button sits off-centre in the tab. The ring is `dcg-thick-outline`
     * because Desmos' icon component gives an action one, the same as a slider's play button -
     * so the two sit at the same weight down a sheet that has both.
     *
     * A cell can be stopped mid-run, which an action cannot, so the busy state is one glyph
     * where the idle state is two: this button is a toggle where Desmos' is a flash.
     *
     * `dcg-action-drag`, `dcg-action-icon-touch` and `dcg-action-icon-mouse` are in that markup
     * too and all have no CSS and no behaviour - they are inert markers, so they are not copied.
     *
     * A note's own `i.dcg-icon-text` is absolutely centred in the same tab; index.css hides it
     * for a cell's row so the two do not sit on top of each other.
     *
     * Done from here rather than by patching the row's template. The row is already ours to
     * decorate - the code box goes in the same way, and attach() is re-run whenever React
     * rebuilds one - so a patch would be a ninth minified pattern to go stale for nothing.
     *
     * Taking the click needs `tapboundary`, not stopPropagation. Desmos' tap dispatcher walks the
     * element chain outwards from the pointer and fires on the first element whose rect contains
     * it, stopping at any element carrying that attribute; without it the tap lands on the tab
     * and starts a drag. It is Desmos' own convention for a control nested inside another -
     * `dcg-slider-container` and the inference footers all carry it.
     */
    function gutter(cell, node) {
        var tab = node.querySelector("span.dcg-tab");
        if (!tab) return;

        var found = tab.querySelector(".cde-lua__icon");
        if (found) {
            cell.icon = found;
            cell.ring = found.querySelector(".dcg-action-icon-view");
            var glyphs = found.querySelectorAll(".dcg-circular-icon i");
            cell.stem = glyphs[0];
            cell.head = glyphs[1];
            cell.fault = found.querySelector(".cde-lua__fault");
            cell.view = cell.fault ? speak(cell.fault) : null;
            return;
        }

        // Two glyphs, not one. Desmos draws an action's arrow as a stem and a head - its icon
        // component asks for a background icon and a primary one, and for an action those are
        // `dcg-icon-minus` and `dcg-icon-chevron-right` layered on top of each other. The
        // chevron on its own is the head with nothing behind it.
        var stem = ui.el("i", { "aria-hidden": "true" });
        var head = ui.el("i", { "aria-hidden": "true" });
        var ring = ui.el(
            "div",
            { class: "dcg-action-icon-view" },
            ui.el(
                "div",
                { class: "dcg-circular-icon-container", role: "button" },
                ui.el(
                    "span",
                    {
                        class:
                            "dcg-do-not-blur dcg-forced-color-none " +
                            "dcg-circular-icon dcg-thick-outline"
                    },
                    stem,
                    head
                )
            )
        );

        // The error form is not a circled icon - in Desmos an expression's error *replaces* the
        // icon in this container with its own TooltippedError, so the two swap rather than
        // stack. That view is mounted into this div; see speak() for what it is and for what
        // stands in its place on a build that no longer offers it.
        var fault = ui.el("div", { class: "cde-lua__fault" });
        var view = speak(fault);

        var icon = ui.el(
            "div",
            {
                class: "dcg-expression-icon-container cde-lua__icon",
                tapboundary: "true",
                onclick: function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    // The row may have been rebuilt since; the cell is looked up, not closed over.
                    var live = lua.cell(cell.id);
                    if (!live) return;
                    // What Ctrl+Enter does, for the same reason: running a cell is a good moment
                    // for what you typed to be the cell the graph has.
                    lua.flush(live.id);
                    lua.runner.toggle(live);
                }
            },
            ring,
            fault
        );

        // Belt and braces for the drag: tapboundary stops Desmos' tap, and this stops anything
        // else on the row that listens the ordinary way.
        ["mousedown", "pointerdown", "touchstart"].forEach(function (type) {
            icon.addEventListener(type, function (event) {
                event.stopPropagation();
            });
        });

        // Inside .dcg-tab-interior, where the slider's is. That div is unstyled and static, so
        // the container still positions itself against the tab either way.
        (tab.querySelector(".dcg-tab-interior") || tab).appendChild(icon);
        cell.icon = icon;
        cell.ring = ring;
        cell.stem = stem;
        cell.head = head;
        cell.fault = fault;
        cell.view = view;
    }

    /**
     * Stand where the note's own text stands.
     *
     * Desmos insets everything in a note - `.dcg-fixed-width-element` is
     * `padding: 15px 35px 9px 53px` - and that 53px on the left is what clears the row's icon
     * gutter. A box inserted beside it without the same inset starts underneath the gutter,
     * where its left edge is cut off and cannot be clicked. Taken from the sibling rather than
     * hard-coded, so the folder variant and any future change come along for free.
     */
    function inset(host, anchor) {
        if (!anchor || !window.getComputedStyle) return;
        var style = window.getComputedStyle(anchor);
        if (style.paddingLeft) host.style.paddingLeft = style.paddingLeft;
        if (style.paddingRight) host.style.paddingRight = style.paddingRight;
    }

    /** The row has gone - scrolled away, not deleted. Keep the model; drop the editor. */
    function detach(cell) {
        var editor = editors.get(cell.id);
        if (editor) {
            // The model is not disposed with it: the model is the text, and the text stays.
            editor.dispose();
            editors.delete(cell.id);
        }
        // Before the node it is mounted in goes: a tooltip pinned open is a child of the tap
        // container rather than of this row, and Desmos' own willUnmount is what takes it away.
        hush(cell);
        if (cell.host && cell.host.parentNode)
            cell.host.parentNode.removeChild(cell.host);
        if (cell.icon && cell.icon.parentNode)
            cell.icon.parentNode.removeChild(cell.icon);
        if (cell.node) cell.node.removeAttribute("data-cde-lua");
        cell.host = null;
        cell.node = null;
        cell.box = null;
        cell.icon = null;
        cell.ring = null;
        cell.stem = null;
        cell.head = null;
        cell.fault = null;
        cell.view = null;
    }

    /** The cell is gone for good. */
    function forget(cell) {
        detach(cell);
        // paint() sweeps ghosts by walking the cells it knows about, and this one is about to
        // stop being one of them. Left behind, its editor would still be holding the model
        // when the timer below disposes it.
        ghost(cell, null);
        var model = models.get(cell.id);
        if (!model) return;
        // A moment's grace, so delete-then-undo keeps its history.
        setTimeout(function () {
            if (lua.cell(cell.id)) return;
            model.dispose();
            models.delete(cell.id);
        }, 5000);
    }

    function build(cell) {
        var host = ui.el("div", { class: "cde-lua" });
        var box = ui.el("div", { class: "cde-lua__box" });

        // Desmos tracks what the pointer is over by writing dcg-hovered onto every element
        // under it. Monaco decides what was clicked by comparing a line's className against
        // "view-line" exactly, so a line wearing a class of Desmos' is a line it does not
        // recognise - clicking the text does nothing. Keeping the mouse inside the box keeps
        // the classes off it. extensions/settings/tabs/themes.js:218-231 is the same fix.
        ["mousedown", "mousemove", "mouseup"].forEach(function (type) {
            box.addEventListener(type, function (event) {
                event.stopPropagation();
            });
        });

        // Desmos binds arrows, Enter and Backspace to moving around the expression list. The
        // editor needs all of them to mean what they mean in an editor.
        //
        // Escape is the one that goes the other way - it leaves the cell, as it leaves an
        // expression. On the host and not as a Monaco command on purpose: Monaco's own
        // keybindings are bound on the box inside this, and it stops the event whenever one
        // of them answers. So an Escape that dismisses the completion list, cancels a rename
        // or collapses a selection never reaches here, and a cell is only left by an Escape
        // the editor itself had nothing to do with.
        ["keydown", "keypress", "keyup"].forEach(function (type) {
            host.addEventListener(type, function (event) {
                event.stopPropagation();
                if (type !== "keydown") return;
                if (event.key === "Escape") {
                    event.preventDefault();
                    toRow(cell);
                }
            });
        });

        ui.el(host, null, box);

        cell.box = box;
        return host;
    }

    // -----------------------------------------------------------------------
    // the editor in it
    // -----------------------------------------------------------------------

    /** Put an editor in the cell's box - Monaco if we have it, a textarea until we do. */
    function mount(cell) {
        if (!cell.box) return;

        if (!api) {
            plain(cell);
            want(true);
            return;
        }
        if (editors.has(cell.id)) return;

        // If the box has the keyboard, the editor should end up with it. This is the first cell
        // anyone makes: it was given a textarea because Monaco had not arrived yet, and
        // replacing that textarea now would otherwise lose the caret it was just handed.
        var had = cell.box.contains(document.activeElement);

        cell.box.textContent = "";
        var editor = api.editor.create(cell.box, {
            model: model(cell),
            theme: "vs-dark",
            // One editor per row and a width we do not set, so Monaco can watch its own
            // container. Height is ours, and wordWrap is off, so this cannot feed back.
            automaticLayout: true,
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            // The completion list is taller than a row has room for; a fixed widget is
            // positioned against the viewport instead of being clipped by the cell.
            fixedOverflowWidgets: true,
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            folding: false,
            wordWrap: "off",
            fontSize: FONT,
            lineHeight: LINE,
            padding: { top: 6, bottom: 6 }
        });
        editors.set(cell.id, editor);

        editor.onDidContentSizeChange(function () {
            size(cell);
        });
        editor.onDidFocusEditorText(function () {
            select(cell);
        });
        // Flush, and only flush. Leaving a cell is not a request to run it.
        editor.onDidBlurEditorText(function () {
            lua.flush(cell.id);
        });
        editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.Enter, function () {
            lua.flush(cell.id);
            lua.runner.run(cell);
        });
        editor.addCommand(api.KeyMod.Shift | api.KeyCode.Enter, function () {
            newRow(cell);
        });
        // Backspace with nothing left to delete: the cell goes, the way an empty expression
        // does. Not a command, which would take the key in every cell however full - this
        // has to ask the model first, and hand the key back to Monaco when there is text.
        editor.onKeyDown(function (event) {
            if (event.keyCode !== api.KeyCode.Backspace) return;
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            var text = editor.getModel();
            if (!text || text.getValue() !== "") return;
            event.preventDefault();
            // Desmos binds this key on the row as well, and by now the note it reads is as
            // empty as the box is: without this, one press would delete two rows.
            event.stopPropagation();
            remove(cell);
        });

        size(cell);
        markers(cell, cell.syntax || cell.error || "");
        if (had) enter(cell);
    }

    /** The box grows with the text, up to a point, after which it scrolls. */
    function size(cell) {
        var editor = editors.get(cell.id);
        if (!editor || !cell.box) return;
        cell.box.style.height = grown(editor) + "px";
    }

    /** How tall a box holding `editor` should be. tall() is the same sum, counted by line. */
    function grown(editor) {
        return Math.min(
            MAX_HEIGHT,
            Math.max(LINE, editor.getContentHeight()) + PAD
        );
    }

    /** The textarea: the way in before Monaco arrives, and the way in if it never does. */
    function plain(cell) {
        var existing = cell.box.querySelector(".cde-lua__plain");
        if (existing) {
            if (existing.value !== cell.source) existing.value = cell.source;
            return;
        }

        var input = ui.el("textarea", {
            class: "cde-lua__plain",
            spellcheck: "false",
            autocapitalize: "off",
            autocomplete: "off",
            wrap: "off",
            "aria-label": "Lua",
            onfocus: function () {
                select(cell);
            },
            oninput: function () {
                lua.edited(cell.id, input.value);
                input.style.height = tall(input.value) + "px";
            },
            onblur: function () {
                lua.flush(cell.id);
            },
            onkeydown: function (event) {
                if (
                    event.key === "Backspace" &&
                    !input.value &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey
                ) {
                    event.preventDefault();
                    // Desmos has this key on the row too; see mount() above.
                    event.stopPropagation();
                    remove(cell);
                    return;
                }
                if (event.key !== "Enter") return;
                if (event.shiftKey) {
                    event.preventDefault();
                    newRow(cell);
                } else if (event.metaKey || event.ctrlKey) {
                    event.preventDefault();
                    lua.flush(cell.id);
                    lua.runner.run(cell);
                }
            }
        });
        input.value = cell.source;
        input.style.height = tall(cell.source) + "px";
        cell.box.textContent = "";
        cell.box.appendChild(input);
    }

    function tall(text) {
        var lines = String(text || "").split("\n").length;
        return Math.min(MAX_HEIGHT, Math.max(LINE, lines * LINE) + PAD);
    }

    /** The model is the text. It outlives the row, which is why scrolling costs nothing. */
    function model(cell) {
        var found = models.get(cell.id);
        if (found) return found;

        found = api.editor.createModel(cell.source, "lua");
        found.updateOptions({
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false
        });
        found.onDidChangeContent(function () {
            lua.edited(cell.id, found.getValue());
        });
        models.set(cell.id, found);
        return found;
    }

    /**
     * The text changed underneath the box - an undo, a graph load, another tab. Catch the box
     * up. Nothing else redraws on its own: the editor and the model are the same text.
     */
    function refresh(cell) {
        var found = models.get(cell.id);
        if (found && found.getValue() !== cell.source)
            // Through an edit rather than setValue, so the editor's own undo history is not
            // thrown away while someone is typing in it.
            found.pushEditOperations(
                null,
                [{ range: found.getFullModelRange(), text: cell.source }],
                null
            );
        var input = cell.box && cell.box.querySelector(".cde-lua__plain");
        if (input && input.value !== cell.source) input.value = cell.source;
    }

    /** Focus a cell that asked to be focused as soon as it had somewhere to be. */
    function take(cell) {
        if (pending !== cell.id) return;
        pending = null;
        enter(cell);
    }

    /**
     * Tell Desmos something, from a place that may already be inside it telling itself
     * something.
     *
     * Its dispatcher is Flux': a dispatch raised during a dispatch throws rather than queueing
     * -  "Cannot dispatch in the middle of a dispatch" - and `runAfterDispatch` is the
     * calculator's own way round it. It runs the callback as the dispatch in progress finishes
     * and runs it immediately when there is none, so this is the plain thing everywhere else.
     *
     * Every dispatch here goes through it, because most of them are raised from a focus event
     * and focus is something Desmos moves from inside a dispatch. An arrow over a selected row
     * is the short version: Desmos answers it with `move-focus-to-item`, the note's textarea
     * takes the keyboard, keys() hands it on to the editor, and the editor saying so - select()
     * below - lands in the middle of the dispatch that started it.
     *
     * Desmos exempts its own focus actions from the rule (the focus tracker absorbs a
     * `set-focus-location` raised mid-dispatch and replays it afterwards) but nothing else, so
     * `set-selected-id` and the rest have to wait their turn.
     *
     * Actions are dispatched in the order given, and a queue is drained in the order it was
     * filled, so two calls stay in the order they were made whichever way this goes.
     */
    function poke(blame, actions) {
        var controller = Calc && Calc.controller;
        if (!controller) return;

        var go = function () {
            try {
                actions.forEach(function (action) {
                    controller.dispatch(action);
                });
            } catch (error) {
                console.warn("desmos: " + blame, error);
            }
        };

        if (controller.runAfterDispatch) controller.runAfterDispatch(go);
        else go();
    }

    /**
     * Put Desmos' selection on this row - the blue marker down its left edge - without touching
     * where the keyboard is. Clicking into a cell has to do this: the editor is ours, so Desmos
     * has no other way of knowing which row is being worked on, and the marker would otherwise
     * stay wherever it was left.
     *
     * Selection only. `move-focus-to-item` would have Desmos focus the row's own textarea and
     * take the keyboard straight back off the editor.
     */
    function select(cell) {
        poke("couldn't select the row", [
            { type: "set-selected-id", id: cell.id }
        ]);
    }

    /**
     * Escape: select the row and let go of the keyboard, which is what Escape over an
     * expression does - and so the expression sheet's own keys work on it afterwards, Enter
     * for a new line below, up and down to walk to the neighbouring ones, Backspace to delete
     * the row however full it is.
     *
     * Desmos' own Escape is a blur and nothing else. The keys for a *selected* row are bound
     * once, on <html>, and that handler stands down unless nothing at all holds the keyboard:
     * anything focused inside the expression panel means the row is being edited rather than
     * selected, and its own input answers for the key instead.
     *
     * Which is why this used to go wrong. Handing the keyboard to the note's own textarea -
     * Desmos' `move-focus-to-item`, and the only DOM focus a note has - put the row in the
     * editing state, where Backspace goes to a textarea that is readOnly (see guard()) and
     * holds the source, and so did nothing at all.
     *
     * The selection is set first because the editor is ours - see select() - and a cell the
     * keyboard reached any other way may have left the selection elsewhere. Desmos' focus
     * location goes with it: the views re-focus whatever it names on the next render, so a
     * stale one would take the keyboard straight back out of this state.
     */
    function toRow(cell) {
        lua.flush(cell.id);

        poke("couldn't hand the row back to Desmos", [
            { type: "set-selected-id", id: cell.id },
            { type: "set-focus-location", location: { type: "unknown" } }
        ]);

        drop(cell);
    }

    /** Let go of the keyboard, without saying where it should go next. */
    function drop(cell) {
        var held = document.activeElement;
        if (!cell.host || !held || !cell.host.contains(held)) return;
        if (held.blur) held.blur();
    }

    /**
     * Shift+Enter: a new expression below this cell, focused - the same thing Escape then Enter
     * does, without the Escape. Plain Enter is left alone, so it still breaks the line inside
     * the cell.
     *
     * `new-expression` inserts at the selection and focuses what it made, so the selection has
     * to be this row first.
     */
    function newRow(cell) {
        lua.flush(cell.id);
        drop(cell);

        poke("couldn't add a line below the cell", [
            { type: "set-selected-id", id: cell.id },
            { type: "new-expression" }
        ]);
    }

    /**
     * Backspace in an empty cell: the row goes, the way an empty expression's does.
     *
     * `on-special-key-pressed` is Desmos' own answer to that key rather than a delete of our
     * own, because the answer is more than a delete: it declines when the cell is the only
     * item left, moves a folder's last cell out of the folder instead of deleting it, and
     * leaves the caret at the end of the row above. None of that is worth reimplementing, and
     * all of it is one undo step, as a delete from the item menu is.
     *
     * It reads the selected item, so the selection has to be this row. Clicking into a cell
     * selects it (select() above), but a cell focused any other way - the one Shift+Enter just
     * made, an Escape and back - may have left the selection elsewhere.
     *
     * The flush is not about saving an empty cell: it is what cancels the pending write that
     * emptying the box left behind. setExpression *creates* an id it does not find, so a write
     * that landed after the delete would put the row back as a plain note.
     */
    function remove(cell) {
        lua.flush(cell.id);
        drop(cell);

        poke("couldn't delete the empty cell", [
            { type: "set-selected-id", id: cell.id },
            { type: "on-special-key-pressed", key: "Backspace" }
        ]);
    }

    // -----------------------------------------------------------------------
    // the chrome
    // -----------------------------------------------------------------------

    /**
     * Repaint what the cell has to say: the gutter icon, and the squiggle in the editor.
     *
     * The ring and the error are two children of the icon container, shown one at a time, which
     * is how Desmos does it - an expression's error *replaces* its icon rather than recolouring
     * it, so the circle should not be there when there is an error to show.
     *
     * The message goes to the view mounted in the gutter, which is Desmos' own tooltip - so an
     * error reads the way an expression's does, in the same bubble, after the same pause, and
     * pinned by the same tap. `title` is what is left for the run button, and it steps aside
     * while there is an error rather than answer the same hover twice.
     *
     * The container stays clickable in either state, so a cell can be run again once its error
     * is fixed - a tap on the error both pins the message and runs the cell.
     */
    function render(cell) {
        guard(cell);
        if (!cell.icon || !cell.ring || !cell.stem || !cell.head || !cell.fault)
            return;

        var problem = cell.syntax || cell.error || "";
        var busy = lua.runner.busy(cell);

        cell.ring.style.display = problem ? "none" : "";
        cell.fault.style.display = problem ? "" : "none";
        // dcg-layered-icon is what Desmos' own icon component puts on each of these; it is inert
        // outside a coloured or image-backed icon, and kept so this is the same markup. Running,
        // the arrow gives way to a single pause glyph - there is no stem to draw behind it.
        if (!problem) {
            cell.stem.className =
                (busy ? "dcg-icon-pause" : "dcg-icon-minus") +
                " dcg-layered-icon";
            cell.stem.style.opacity = "1";
            cell.head.className = "dcg-icon-chevron-right dcg-layered-icon";
            cell.head.style.display = busy ? "none" : "";
        }

        var title = problem
            ? problem
            : busy
              ? cell.parked
                  ? "Waiting for the graph - click to stop"
                  : "Stop this cell"
              : "Run this cell";
        // The view reads this rather than being handed it: a dcg-view prop is a getter, and
        // update() is how Desmos tells one to look again. Told nothing, the tooltip takes
        // itself away, which is what fixing an error does to it.
        says.set(cell.fault, problem);
        if (cell.view) cell.view.update();

        if (problem && cell.view) cell.icon.removeAttribute("title");
        else cell.icon.setAttribute("title", title);
        cell.icon.setAttribute("aria-label", title);

        markers(cell, problem);
    }

    /** A squiggle under the line the error names, when there is an editor to put one in. */
    function markers(cell, problem) {
        if (!api) return;
        var found = models.get(cell.id);
        if (!found) return;
        if (!problem) return api.editor.setModelMarkers(found, "cde-lua", []);

        var line = lua.runner.line(cell, problem);
        if (!line) return api.editor.setModelMarkers(found, "cde-lua", []);
        api.editor.setModelMarkers(found, "cde-lua", [
            {
                severity: api.MarkerSeverity.Error,
                message: problem,
                startLineNumber: line,
                endLineNumber: line,
                startColumn: 1,
                endColumn: found.getLineMaxColumn(line)
            }
        ]);
    }

    // -----------------------------------------------------------------------
    // the error
    // -----------------------------------------------------------------------
    //
    // An expression's error in Desmos is a `TooltippedError`: the warning glyph, wrapped in
    // Desmos' `Tooltip`, which is what draws the bubble under it after half a second, pins it
    // when it is tapped, keeps it inside the sheet and takes it away again. None of that is in
    // the markup - the tooltip binds its listeners when it mounts, and Desmos' own hover
    // dispatcher speaks to it over the jQuery events it bound - so a hand-rolled copy of the
    // markup gets the icon and nothing else, which is what a `title` was standing in for.
    //
    // So the view is mounted rather than imitated. `Desmos.Private.Fragile` is the namespace the
    // calculator hands out its own internals through - builtins.js takes `evaluateLatex` from
    // the same place - and it carries `DCGView` and `Tooltip`. `TooltippedError` itself is not
    // on the list, but it is six lines of Desmos' own source and every one of those lines is
    // made of something that *is*:
    //
    //     Tooltip({ tooltip: props.error, sticky: () => props.sticky?.() ?? true,
    //               gravity: props.gravity,
    //               additionalClass: "dcg-tooltipped-error-container" },
    //       div.dcg-tooltipped-error > i.dcg-icon-error)
    //
    // rebuilt below, prop for prop. What is doing the work is Desmos', which is the point: the
    // delay, the placement, the arrow, the pinning and the fade all come from the component
    // rather than from numbers copied out of a stylesheet and left to drift.
    //
    // A build that moves `Fragile` costs the bubble and nothing else: speak() returns null, the
    // glyph is drawn the way it always was, and render() leaves the message on `title`.

    /** What each mounted error has to say. Read by the view; written by render(). */
    var says = new WeakMap();

    /** Desmos' view layer, when this build still hands it out. */
    function parts() {
        var D = window.Desmos;
        var found = (D && D.Private && D.Private.Fragile) || null;
        var View = found && found.DCGView;
        if (
            !View ||
            typeof View.Class !== "function" ||
            typeof View.createElement !== "function" ||
            typeof View.mountToNode !== "function" ||
            typeof View.unmountFromNode !== "function" ||
            typeof found.Tooltip !== "function"
        )
            return null;
        return found;
    }

    /** Desmos' TooltippedError, built once out of those. */
    var Fault = null;

    /** A build we have already complained about, or one whose view would not mount. */
    var mute = false;

    function fault() {
        if (Fault) return Fault;

        var found = parts();
        if (!found) {
            if (!mute)
                console.warn(
                    "desmos: no Desmos.Private.Fragile.Tooltip, so a Lua cell's error is " +
                        "a plain title"
                );
            mute = true;
            return null;
        }

        var View = found.DCGView;
        var Tooltip = found.Tooltip;
        var make = View.createElement;
        Fault = class extends View.Class {
            template() {
                return make(Tooltip, {
                    tooltip: this.props.error,
                    // Sticky is what an expression's error is: a tap pins the message, so a long
                    // one can be read and copied rather than chased with the pointer.
                    sticky: this.const(true),
                    additionalClass: this.const(
                        "dcg-tooltipped-error-container"
                    ),
                    children: make("div", {
                        class: this.const("dcg-tooltipped-error"),
                        children: make("i", {
                            class: "dcg-icon-error",
                            "aria-hidden": "true"
                        })
                    })
                });
            }
        };
        return Fault;
    }

    /**
     * Mount one into `node`, and hand back the view - or null, which is the signal to fall back
     * to `title`.
     *
     * A row React rebuilt hands us back our own icon with the view still mounted in it, so an
     * already-mounted node is answered with what is there: mountToNode refuses a second one.
     */
    function speak(node) {
        if (node._mountedDCGView) return node._mountedDCGView;

        var found = mute ? null : parts();
        var Component = found && fault();
        if (Component)
            try {
                return found.DCGView.mountToNode(Component, node, {
                    error: function () {
                        return says.get(node) || "";
                    }
                });
            } catch (error) {
                // Not tried again: a view that would not mount will not mount for the next
                // cell either, and every cell on the graph saying so helps nobody.
                console.warn(
                    "desmos: couldn't mount Desmos' error view",
                    error
                );
                mute = true;
            }

        glyph(node);
        return null;
    }

    /**
     * The glyph alone, drawn by hand into the same node - what this used to be, and what is
     * left when there is no view to mount. Idempotent, because gutter() finds its own icon
     * again every time React rebuilds a row.
     */
    function glyph(node) {
        if (node.querySelector(".dcg-tooltipped-error")) return;
        ui.el(
            node,
            null,
            ui.el(
                "div",
                { class: "dcg-tooltipped-error" },
                ui.el("i", { class: "dcg-icon-error", "aria-hidden": "true" })
            )
        );
    }

    /**
     * Take the view down with the row. Desmos' tooltip hangs its bubble off the tap container
     * rather than off the row, and it is the component's own willUnmount that removes it - a
     * node pulled out from under a pinned tooltip would leave the bubble on the screen.
     */
    function hush(cell) {
        if (!cell.fault || !cell.fault._mountedDCGView) return;
        var found = parts();
        if (!found) return;
        try {
            found.DCGView.unmountFromNode(cell.fault);
        } catch (error) {
            console.warn("desmos: couldn't unmount Desmos' error view", error);
        }
    }

    // -----------------------------------------------------------------------
    // Monaco
    // -----------------------------------------------------------------------

    /**
     * Ask ../../monaco.js for the editor, once. `now` is for a cell that is on the screen
     * waiting for one; without it the load waits for the page to go idle, which is what the
     * ask in init() does - nothing is waiting for it yet and the graph is still opening.
     * Either way it is the same single load, and this only decides when it starts.
     */
    function want(now) {
        var shared = window.__desmosExt.monaco;
        var start = now ? shared.load() : shared.warm();
        if (!loading)
            loading = start.then(arrive, function (error) {
                console.warn(
                    "desmos: Monaco didn't load, so Lua cells are plain textareas",
                    error
                );
            });
        return loading;
    }

    /** Monaco has arrived: give every cell already on screen a real editor. */
    function arrive(monaco) {
        api = monaco;
        complete();
        lua.cells.forEach(function (cell) {
            if (cell.box) mount(cell);
        });
    }

    /** What the graph and the bridge can offer the completion list. */
    function complete() {
        var BUILTIN = [
            [
                "Desmos.get",
                'Desmos.get("\\\\sin(2)")',
                "The value of any latex, blocking until it has one."
            ],
            [
                "Desmos.define",
                'Desmos.define("g(x)", "x^{2}+1")',
                "Write an expression's latex yourself."
            ],
            [
                "Desmos.sample",
                'Desmos.sample("g", f, 0, 10, 200)',
                "Plot a Lua function as sampled points."
            ],
            [
                "Desmos.items",
                'Desmos.items.P.color = "#aabbcc"',
                "The sheet's items, by name, by id or by position."
            ],
            [
                "Desmos.settings",
                "Desmos.settings.showGrid = false",
                "The graph's own settings, and its viewport."
            ],
            [
                "Desmos.ticker",
                "Desmos.ticker.playing = true",
                "The ticker: its handler, its step, and whether it runs."
            ]
        ];

        /**
         * The globals that are not `Desmos`'. Kept apart from BUILTIN because that list is also
         * what a `Desmos.` is answered with, and these do not go behind one.
         */
        var GLOBAL = [
            [
                "point",
                "Desmos.P = point(1, 2)",
                "A Desmos point. Two coordinates, or three in the 3D calculator."
            ],
            [
                "action",
                "A = action(function() b = 1 end)",
                "Mark a body as one that changes the graph. Without it a function " +
                    "computes a value and nothing else."
            ]
        ];

        api.languages.registerCompletionItemProvider("lua", {
            // Monaco asks on its own after a letter; a dot has to be asked for, and every one
            // of the lists below is behind one.
            triggerCharacters: ["."],

            provideCompletionItems: function (model, position) {
                var word = model.getWordUntilPosition(position);
                var range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn
                };

                // What has been typed up to the word being completed, which is what says
                // whether this is a member of something rather than a name of its own.
                var before = model.getValueInRange({
                    startLineNumber: position.lineNumber,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: word.startColumn
                });

                var member = members(before, range);
                if (member) return { suggestions: member };

                var items = BUILTIN.concat(GLOBAL).map(function (entry) {
                    return {
                        label: entry[0],
                        kind: api.languages.CompletionItemKind.Function,
                        detail: entry[1],
                        documentation: entry[2],
                        insertText: entry[0],
                        range: range
                    };
                });

                lua.bridge.names().forEach(function (name) {
                    items.push({
                        label: name,
                        kind: api.languages.CompletionItemKind.Variable,
                        detail: "on the graph",
                        insertText: name,
                        range: range
                    });
                });

                // Desmos' own functions. Reachable unqualified, because a name the graph does
                // not define falls back to `Desmos` - so `arctan` is offered, not `Desmos.arctan`.
                if (lua.builtins)
                    lua.builtins.names().forEach(function (name) {
                        items.push({
                            label: name,
                            kind: api.languages.CompletionItemKind.Function,
                            detail: "a Desmos function",
                            insertText: name,
                            range: range
                        });
                    });

                return { suggestions: items };
            }
        });

        /**
         * The list for a member access, or null when this is an ordinary name.
         *
         * Three of them, and the first is a bug as much as a feature: the flat list offers
         * `Desmos.get`, so accepting it after `Desmos.` used to leave `Desmos.Desmos.get` in
         * the box. A dot is now answered with the bare names that can follow it.
         */
        function members(before, range) {
            if (/(^|[^.\w])Desmos\.$/.test(before))
                return BUILTIN.map(function (entry) {
                    return {
                        label: entry[0].slice("Desmos.".length),
                        kind: api.languages.CompletionItemKind.Property,
                        detail: entry[1],
                        documentation: entry[2],
                        insertText: entry[0].slice("Desmos.".length),
                        range: range
                    };
                });

            // What an item, the settings or the ticker has - out of the very tables items.js
            // checks a write against, so the list and the rules cannot disagree - and the
            // graph's own names after `Desmos.items.`, which is how an item is looked up.
            var offered =
                lua.items && lua.items.suggest
                    ? lua.items.suggest(before)
                    : null;
            if (!offered) return null;

            return offered.map(function (one) {
                return {
                    label: one.name,
                    kind:
                        one.kind === "name"
                            ? api.languages.CompletionItemKind.Variable
                            : api.languages.CompletionItemKind.Property,
                    detail: one.detail,
                    documentation: one.documentation || undefined,
                    insertText: one.name,
                    range: range
                };
            });
        }
    }
})();
