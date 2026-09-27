// The Themes tab: a CSS editor, and the three things to do with what has been typed into it.
// Preview puts the sheet on the page until it is next reloaded; Save also writes it to
// localStorage, and `main` below puts it back on every load after that; Reset goes back to
// the saved sheet, in the box and on the page. Nothing else reads that sheet, so a theme is
// whatever CSS the calculator will take - Desmos' own class names and its --dcg-* custom
// properties are the handles worth reaching for.
//
// `?theme=` decides instead, for one load: base64 of a CSS file to use in place of the saved
// one - a theme that can be linked to rather than installed - and `?theme=none` (or an empty
// `?theme=`) for no theme at all, which is the way back in from a sheet that has hidden the
// modal this tab is in. A linked theme is what the editor opens on, so Save is how it is
// kept and Reset is how it is thrown away.
//
// The box itself is Monaco, the editor out of VS Code, for the syntax highlighting and the
// completion its CSS language service brings. It is ../../../monaco.js' copy, shared with
// extensions/lua, and it is asked for when the graphs modal is opened rather than when this
// tab is - by the time anyone has read the tab headings and clicked this one, it is usually
// already here. Until it arrives - or for good, if it never does - the box is a plain
// textarea with a line gutter, which is worth keeping around: this tab is the way out of a
// theme that has broken the page, and it should not need a CDN to be that.
//
// Neither box holds the text. `draft` does, and it outlives both: the modal builds its body
// when it opens and throws it away when it closes, and a half-written theme should still be
// there the next time it is opened.
//
// A tab of the settings extension; ../index.js owns the registry this hands itself to, and
// the patches that give the tab somewhere to be.
(function () {
    /** Where Save leaves the sheet, beside "desmos-extensions" (extensions.js). */
    var STORAGE = "desmos-theme";

    /** What a theme looks like, for an empty textarea that Monaco is not going to replace. */
    var EXAMPLE =
        ".dcg-calculator-api-container {\n    --dcg-accent-color: #c74440;\n}";

    // What ?theme= asks for, read now rather than when it is wanted: the address bar is
    // rewritten as graphs are opened and saved, and the answer should not move with it.
    //
    //   null               there is no ?theme=; the saved sheet is the theme
    //   { css: "..." }     that sheet instead, for this load - "" for ?theme=none
    //   { problem: "..." } ?theme= was there and could not be read; the saved sheet stands
    var REQUESTED = requested();

    function requested() {
        var raw = new URLSearchParams(location.search).get("theme");
        if (raw === null) return null;
        var payload = raw.trim();
        if (!payload || payload.toLowerCase() === "none") return { css: "" };
        try {
            return { css: decode(payload) };
        } catch (error) {
            return { problem: "Couldn't read ?theme=: " + error.message };
        }
    }

    /**
     * A ?theme= payload: base64 of the CSS, in either alphabet. A query string turns a "+"
     * into a space on the way in, so spaces are read back as the "+" they were; a link that
     * would rather not rely on that can write base64url and be decoded just the same.
     */
    function decode(payload) {
        var base64 = payload.replace(/[\s-]/g, "+").replace(/_/g, "/");
        // atob() gives one byte per character, and the CSS was encoded from UTF-8.
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    // The <style> the theme is written into, made the first time one is applied. Ours rather
    // than ui.css()'s: that one is write-once per key on purpose, and a preview is the same
    // sheet being rewritten.
    var sheet = null;

    // What the box is showing, which is not what is saved - it is a draft until one of the
    // buttons is pressed. Null until the tab is first opened, so that a load which never
    // opens it doesn't read storage twice.
    var draft = null;

    Extensions.settings.tab({
        key: "themes",
        label: "Themes",
        render: themesTab,
        main: applyStart,
        // The modal is open, so this tab is one click away: fetch the editor now and the box
        // is drawn as Monaco the moment it is asked for, instead of as a textarea that is
        // replaced a second later. Nothing is waiting on it yet, so it goes when idle.
        opening: function () {
            monaco().warm();
        }
    });

    /** The saved sheet, or "" - private browsing included. */
    function saved() {
        try {
            return window.localStorage.getItem(STORAGE) || "";
        } catch (error) {
            return "";
        }
    }

    /** Put `css` on the page, in place of whatever was there before. */
    function apply(css) {
        if (!sheet) {
            sheet = document.createElement("style");
            sheet.setAttribute("data-desmos-ext", "theme");
            (document.head || document.documentElement).appendChild(sheet);
        }
        sheet.textContent = css;
    }

    /**
     * The theme this load starts with - ?theme= if it named one, the saved sheet otherwise.
     * The settings extension's main(), by way of the tab registry.
     */
    function applyStart() {
        if (REQUESTED && REQUESTED.problem)
            console.warn("desmos: " + REQUESTED.problem);
        var css =
            REQUESTED && typeof REQUESTED.css === "string"
                ? REQUESTED.css
                : saved();
        if (css) apply(css);
    }

    // -----------------------------------------------------------------------
    // Monaco
    // -----------------------------------------------------------------------

    /** ../../../monaco.js: one copy of the editor, shared with extensions/lua. */
    function monaco() {
        return window.__desmosExt.monaco;
    }

    // Monaco's copy of the text, made once and kept: the editor is thrown away with the
    // modal's body, and reopening it should not cost the undo history along with it.
    var model = null;

    function theModel(api) {
        if (!model) {
            model = api.editor.createModel(draft, "css");
            // On the model rather than in the editor's options: indentation belongs to the
            // text, and the editor is handed this one already made.
            model.updateOptions({
                tabSize: 4,
                insertSpaces: true,
                detectIndentation: false
            });
            model.onDidChangeContent(function () {
                draft = model.getValue();
            });
        }
        return model;
    }

    // -----------------------------------------------------------------------
    // the tab
    // -----------------------------------------------------------------------

    function themesTab(root) {
        var ui = window.__desmosExt.ui;

        // A link's theme is what the box opens on, so that Save is how it is kept; a
        // ?theme=none is not a theme to keep, and leaves the saved one on show to be fixed.
        if (draft === null) draft = (REQUESTED && REQUESTED.css) || saved();

        var host = ui.el("div", { class: "cde-theme__editor" });

        // Desmos keeps track of what the pointer is over by writing dcg-hovered - and
        // dcg-depressed, while a button is down - onto every element under it, from mouse
        // listeners on the document. Monaco works out what was clicked by comparing a
        // line's className against "view-line" exactly, so a line wearing a class of
        // Desmos' is a line it does not recognise: clicking the text does nothing, while
        // clicking past the end of it takes another path through the hit test and still
        // works. Keeping the mouse events inside the box keeps the classes off it. Only
        // the three the tap system listens for, and only on the way out: Monaco's
        // listeners are inside `host` and have had the event by now, and its dragging
        // rides on pointer events, which still reach the document as they always did.
        ["mousedown", "mousemove", "mouseup"].forEach(function (type) {
            host.addEventListener(type, function (event) {
                event.stopPropagation();
            });
        });
        ui.el(
            root,
            null,
            ui.el(
                "div",
                { class: "cde-theme__bar" },
                button("Reset", reset),
                button("Preview", preview),
                button("Save", save, true)
            ),
            host
        );

        // Whichever box is in `host`. Monaco if it is already here - opening the modal asked
        // for it (`opening` above), so by the time this tab is clicked it usually is, and
        // then there is no textarea to be seen appearing and replaced. The textarea until
        // then, if not: a box that cannot be typed into while a CDN is thought about is no
        // use to anyone, least of all to someone here to undo a theme.
        //
        // Built after `host` is on the page: Monaco measures its container as it is created.
        var here = monaco().api();
        var box = here ? code(here) : textbox();
        var live = true;

        if (!here)
            monaco()
                .load()
                .then(
                    function (api) {
                        if (live) box = code(api);
                    },
                    function (error) {
                        console.warn(
                            "desmos: Monaco didn't load, so the theme box is a plain textarea",
                            error
                        );
                        // The textarea is the box for good, so it may as well say what goes
                        // in one. Held back until now so that an example does not flash up
                        // in a box that was about to be replaced.
                        if (live) box.hint(EXAMPLE);
                    }
                );

        return function () {
            live = false;
            box.dispose();
        };

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

        /** Back to the saved theme, in the box and on the page. */
        function reset() {
            draft = saved();
            box.set(draft);
            apply(draft);
        }

        function preview() {
            apply(box.value());
        }

        function save() {
            var css = box.value();
            apply(css);
            try {
                window.localStorage.setItem(STORAGE, css);
            } catch (error) {
                // Private browsing, or a sheet past the quota: it is on the page either way,
                // it just will not be there after a reload.
                console.warn("desmos: couldn't save the theme", error);
            }
        }

        // --- the box, in its two forms. Both answer for the text they are showing, keep
        // --- `draft` up to date for whichever comes next, and can be told to show something
        // --- else. The buttons ask the box rather than read `draft`: a mirror is one more
        // --- thing that can be stale, and what is saved has to be what is on the screen.

        /** The plain one: a textarea, with a gutter that scrolls with it. */
        function textbox() {
            var lines = ui.el("div", {
                class: "cde-theme__lines",
                "aria-hidden": "true"
            });

            // Not wrapped, so that a line of the theme is a line of the gutter.
            var input = ui.el("textarea", {
                class: "cde-theme__input",
                spellcheck: "false",
                autocapitalize: "off",
                autocomplete: "off",
                wrap: "off",
                "aria-label": "Theme CSS",
                oninput: function () {
                    draft = input.value;
                    number();
                },
                onscroll: function () {
                    lines.scrollTop = input.scrollTop;
                },
                onkeydown: function (event) {
                    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                        event.preventDefault();
                        save();
                    }
                }
            });
            // A value is state rather than markup, so it is set here and not by ui.el().
            input.value = draft;

            host.appendChild(lines);
            host.appendChild(input);
            number();

            return {
                value: function () {
                    return input.value;
                },
                set: function (css) {
                    input.value = css;
                    number();
                },
                /** Say what a theme looks like, once this is the box it will be typed into. */
                hint: function (example) {
                    input.placeholder = example;
                },
                dispose: function () {
                    host.textContent = "";
                }
            };

            /** The gutter: one number per line of the textarea. */
            function number() {
                var count = input.value.split("\n").length;
                var text = "";
                for (var i = 1; i <= count; i++)
                    text += (i > 1 ? "\n" : "") + i;
                lines.textContent = text;
                lines.scrollTop = input.scrollTop;
            }
        }

        /** Monaco, in place of whatever was in the box before it finished loading. */
        function code(api) {
            if (box) box.dispose();
            host.className = "cde-theme__editor cde-theme__editor--code";

            var editor = api.editor.create(host, {
                model: theModel(api),
                theme: "vs-dark",
                // The modal is resized by its own chrome as well as by the window, so the
                // editor watches its container rather than listening for a resize.
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                // The completion list is taller than the modal has room for below the
                // caret; fixed widgets are positioned against the viewport instead, so it
                // is not cut off at the edge of the box.
                fixedOverflowWidgets: true,
                fontSize: 13,
                padding: { top: 8, bottom: 8 }
            });
            editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, save);

            return {
                value: function () {
                    return editor.getModel().getValue();
                },
                set: function (css) {
                    // Through the model, so that the change is undoable and `draft` hears
                    // about it the same way typing is heard about.
                    editor.getModel().setValue(css);
                },
                // The model is not disposed with it: it is the text, and the text stays.
                dispose: function () {
                    editor.dispose();
                }
            };
        }
    }
})();
