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

    /** A cell to focus as soon as its row turns up - the freshly created one. */
    var pending = null;

    /** Rows we have already bound keys on, so a re-render does not stack another listener. */
    var bound = new WeakSet();

    var Calc = null;
    var ui = null;

    lua.editor = {
        init: init,
        attach: attach,
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
    }

    /**
     * Desmos' own textarea for the row keeps the keyboard whenever the editor does not - that is
     * what makes Escape, Tab and the arrows work - but it also still holds the note's text. Left
     * writable, anything typed while the row is focused is spliced into it by Desmos' own note
     * editing, and scan() then faithfully carries it into the code box.
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
     */
    function keys(cell, node) {
        if (bound.has(node)) return;
        bound.add(node);

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
            cell.fault = found.querySelector(".dcg-tooltipped-error");
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
        // icon in this container with exactly this pair, so the two swap rather than stack.
        var fault = ui.el(
            "div",
            { class: "dcg-tooltipped-error" },
            ui.el("i", { class: "dcg-icon-error", "aria-hidden": "true" })
        );

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
    }

    /** The cell is gone for good. */
    function forget(cell) {
        detach(cell);
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
        var h = Math.min(
            MAX_HEIGHT,
            Math.max(LINE, editor.getContentHeight()) + PAD
        );
        cell.box.style.height = h + "px";
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
     * Put Desmos' selection on this row - the blue marker down its left edge - without touching
     * where the keyboard is. Clicking into a cell has to do this: the editor is ours, so Desmos
     * has no other way of knowing which row is being worked on, and the marker would otherwise
     * stay wherever it was left.
     *
     * Selection only. `move-focus-to-item` would have Desmos focus the row's own textarea and
     * take the keyboard straight back off the editor.
     */
    function select(cell) {
        var controller = Calc && Calc.controller;
        if (!controller) return;
        try {
            controller.dispatch({ type: "set-selected-id", id: cell.id });
        } catch (error) {
            console.warn("desmos: couldn't select the row", error);
        }
    }

    /**
     * Escape: give the row to Desmos, so the expression sheet's own keys work on it - Enter for
     * a new line below, up and down to walk to the neighbouring ones.
     *
     * Desmos keeps focus as state and the views follow it, so `move-focus-to-item` - its own
     * "focus this row" - is half of it. The other half is DOM focus, and for a note that means
     * the note's own textarea: its keydown is where Desmos' navigation for a note lives. The row
     * container will not do, tabIndex or not - its own keydown only handles reorder mode, which
     * is why Escape used to leave the keyboard nowhere at all.
     *
     * index.css keeps that textarea at a point rather than hiding it, for exactly this.
     */
    function toRow(cell) {
        lua.flush(cell.id);

        var controller = Calc && Calc.controller;
        if (controller)
            try {
                controller.dispatch({ type: "set-selected-id", id: cell.id });
                controller.dispatch({
                    type: "move-focus-to-item",
                    id: cell.id
                });
            } catch (error) {
                console.warn(
                    "desmos: couldn't hand the row back to Desmos",
                    error
                );
            }

        var area =
            cell.node && cell.node.querySelector("textarea.dcg-smart-textarea");
        if (area) return area.focus();

        // Nothing of Desmos' to hand it to. Its focus state is still right, so at least stop
        // holding the keyboard here.
        drop(cell);
        if (cell.node && cell.node.focus) cell.node.focus();
    }

    /** Let go of the keyboard, without saying where it should go next. */
    function drop(cell) {
        if (!cell.box) return;
        var area = cell.box.querySelector("textarea");
        if (area) area.blur();
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

        var controller = Calc && Calc.controller;
        if (!controller) return;
        try {
            controller.dispatch({ type: "set-selected-id", id: cell.id });
            controller.dispatch({ type: "new-expression" });
        } catch (error) {
            console.warn("desmos: couldn't add a line below the cell", error);
        }
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

        var controller = Calc && Calc.controller;
        if (!controller) return;
        try {
            controller.dispatch({ type: "set-selected-id", id: cell.id });
            controller.dispatch({
                type: "on-special-key-pressed",
                key: "Backspace"
            });
        } catch (error) {
            console.warn("desmos: couldn't delete the empty cell", error);
        }
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
     * The message itself rides on `title`. Desmos' tooltip binds its listeners when it mounts and
     * there is no way into it from markup alone, so a native tooltip is as close as this gets.
     * The container stays clickable in either state, so a cell can be run again once its error is
     * fixed.
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
        cell.icon.setAttribute("title", title);
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
