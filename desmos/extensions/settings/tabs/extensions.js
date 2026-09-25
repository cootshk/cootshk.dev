// The Extensions tab: one card per extension in the manifest, a toggle on each, a search box
// over the lot and the "Apply and Reload" a flipped toggle needs - nothing here takes effect
// until the page has loaded again.
//
// A tab of the settings extension; ../index.js owns the registry this hands itself to, and
// the patches that give the tab somewhere to be.
(function () {
    Extensions.settings.tab({
        key: "extensions",
        label: "Extensions",
        render: extensionsTab
    });

    function extensionsTab(root) {
        var ui = window.__desmosExt.ui;

        var search = ui.el("input", {
            class: "cde-ext__search",
            type: "search",
            placeholder: "Search extensions",
            "aria-label": "Search extensions",
            oninput: filter
        });

        // Nothing a toggle does outlives the page until this is pressed - see ui.js.
        var reload = ui.el("button", {
            class: "cde-ext__reload",
            type: "button",
            text: "Apply and Reload",
            hidden: !ui.dirty(),
            onclick: ui.apply
        });

        // ?ext= decides the load it is part of, so the toggles below are showing it rather
        // than the stored set and are read-only. This says so, and offers the way out.
        var unlock = ui.overridden()
            ? ui.el("button", {
                  class: "cde-ext__unlock",
                  type: "button",
                  text: "Unlock",
                  title: "Edit these anyway. Applying drops ?ext= from the address.",
                  onclick: function () {
                      ui.unlock();
                  }
              })
            : null;
        var note = ui.overridden()
            ? ui.el(
                  "p",
                  { class: "cde-ext__note" },
                  ui.el("span", {
                      text: "?ext= in the URL is overriding these."
                  }),
                  unlock
              )
            : null;

        var grid = ui.el("div", { class: "cde-ext__grid" });
        var empty = ui.el("p", { class: "cde-ext__empty", hidden: true });

        var cards = ui.list().map(function (entry) {
            var drawn = card(entry);
            return {
                node: drawn.node,
                unlock: drawn.unlock,
                // id included: it is what ?ext= takes, so it is worth being able to
                // search for even though the card shows the name.
                haystack: (
                    entry.name +
                    " " +
                    entry.description +
                    " " +
                    entry.id
                ).toLowerCase()
            };
        });
        grid.append.apply(
            grid,
            cards.map(function (one) {
                return one.node;
            })
        );

        ui.el(
            root,
            null,
            ui.el("div", { class: "cde-ext__bar" }, search, reload),
            note,
            grid,
            empty
        );

        function filter() {
            var query = search.value.trim();
            var needle = query.toLowerCase();
            var shown = 0;
            cards.forEach(function (one) {
                var hit = !needle || one.haystack.indexOf(needle) !== -1;
                one.node.hidden = !hit;
                if (hit) shown++;
            });
            empty.hidden = shown > 0;
            empty.textContent = 'No extensions match "' + query + '".';
        }

        return ui.onDirty(function () {
            reload.hidden = !ui.dirty();
            // Unlocking does not redraw the tab, so the switches it frees are told directly.
            if (unlock && ui.unlocked()) {
                unlock.hidden = true;
                cards.forEach(function (one) {
                    one.unlock();
                });
            }
        });
    }

    /** A card, and the way to free its toggle if the tab is unlocked later. */
    function card(entry) {
        var ui = window.__desmosExt.ui;

        var box = ui.el("input", {
            class: "cde-ext-toggle__box",
            type: "checkbox",
            checked: ui.enabled(entry.id),
            disabled: ui.locked(entry.id),
            "aria-label": entry.name,
            onchange: function () {
                ui.setEnabled(entry.id, box.checked);
            }
        });

        var toggle = ui.el(
            "label",
            {
                class: "cde-ext-toggle",
                title: entry.forced
                    ? "Always on"
                    : ui.overridden()
                      ? "?ext= in the URL is overriding this"
                      : null
            },
            box,
            ui.el("span", { class: "cde-ext-toggle__track" })
        );

        var node = ui.el(
            "div",
            {
                class:
                    "cde-ext-card" +
                    (entry.supported ? "" : " cde-ext-card--unsupported")
            },
            ui.el(
                "div",
                { class: "cde-ext-card__head" },
                ui.el("h3", {
                    class: "cde-ext-card__name",
                    text: entry.name
                }),
                toggle
            ),
            ui.el("p", {
                class: "cde-ext-card__desc",
                text: entry.supported
                    ? entry.description
                    : "Not available on this calculator."
            }),
            // A panel belongs to a running extension, so there is nothing to draw for one
            // that has been switched off until the page is reloaded.
            ui.hasPanel(entry.id) ? settings(entry) : null
        );

        return {
            node: node,
            unlock: function () {
                if (ui.locked(entry.id)) return;
                box.disabled = false;
                toggle.removeAttribute("title");
            }
        };
    }

    /** The "Settings" disclosure on a card, drawn the first time it is opened. */
    function settings(entry) {
        var ui = window.__desmosExt.ui;
        var panel = ui.el("div", {
            class: "cde-ext-card__panel",
            hidden: true
        });
        var drawn = false;
        var button = ui.el("button", {
            class: "cde-ext-card__more",
            type: "button",
            text: "Settings",
            "aria-expanded": "false",
            onclick: function () {
                panel.hidden = !panel.hidden;
                button.setAttribute("aria-expanded", String(!panel.hidden));
                if (drawn) return;
                drawn = true;
                ui.renderPanel(entry.id, panel);
            }
        });
        return [button, panel];
    }
})();
