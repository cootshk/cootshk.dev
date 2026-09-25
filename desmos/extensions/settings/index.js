// The tabs this site adds to Desmos' saved-graphs modal, and the patches that make room for
// them. What a tab draws lives beside this file - tabs/extensions.js, tabs/themes.js and
// tabs/patchHelper.js - and each of those registers itself here.
//
// Desmos keeps the open tab as a single id on the modal's controller, so a tab of ours is
// just an id that controller has never heard of: every tab it does know deselects itself,
// and the body patch below picks ours up instead. A tab is therefore three patches - a
// heading in the tablist, a string to label it with, and a branch in the body - and all
// three are generated from the registry, so there is one place to add the next one.
//
// Everything is wrapped in a function because an extension's scripts share the global scope
// with the loader and with every other extension; only `extension()` is called from the top
// level. That also means the loader's own helpers are in scope here and in the tab files -
// `Extensions`, `canonicalizeMatch`, `countMatches` and `expandSelf` from extensions.js,
// `BUILD_SCRIPT` from desmos.js.
(function () {
    // A tab is its `key` - the tab id, CSS class and translation key are all built from it -
    // the `label` on its heading, and a `render` that draws its body into a container of its
    // own. `when` gates a tab: the Patch Helper is a tool for writing extensions, and is only
    // there when the extension by that name is enabled. `main` is the settings extension's
    // own main() hook, shared out: a tab whose work outlives the modal - the saved theme,
    // which is applied whether or not anyone opens the tab - does it from there.
    //
    // `id` takes over a tab Desmos already has rather than adding one: it is the id Desmos
    // itself uses, so the heading and the label are already there and only the body is ours.
    // That is how Saved Graphs works - "my-graphs" is a tab nobody can use logged out, and
    // there is no logging in here.
    //
    // Filled by the files in tabs/, which extensions.json lists after this one, so the tabs
    // come out in the order the manifest names them.
    var TABS = [];

    /**
     * The tabs to draw. Read while the bundle is being patched, by which point every
     * extension this load is running has registered - so `when` may ask after its neighbours,
     * which it could not do from the top level of a tab file.
     */
    function tabs() {
        return TABS.filter(function (tab) {
            return !tab.when || tab.when();
        });
    }

    /** The id Desmos' controller is given for a tab. Also the name of its ui slot. */
    function tabId(tab) {
        return tab.id || "cde-" + tab.key;
    }

    /**
     * The tabs that need a heading of their own - the ones we are adding. A tab with an `id`
     * is one Desmos already draws a heading for, and a second one would be a duplicate.
     */
    function added() {
        return tabs().filter(function (tab) {
            return !tab.id;
        });
    }

    // -----------------------------------------------------------------------
    // the patches
    // -----------------------------------------------------------------------

    /** A tab's heading, in the markup Desmos writes its own headings with. */
    function heading(h, translate, tab) {
        var id = JSON.stringify(tabId(tab));
        var current = "this.myGraphsController.getCurrentTab()===" + id;
        return (
            h +
            '("div",{class:"dcg-my-graphs-modal__tab",children:[' +
            h +
            "(\"a\",{class:()=>({'dcg-unstyled-heading':!0,'dcg-my-graphs-modal__heading':!0," +
            "'dcg-my-graphs-modal__heading--selectable':!0," +
            "'dcg-my-graphs-modal-" +
            tabId(tab) +
            "-header':!0,'dcg-selected':" +
            current +
            "})," +
            'role:"tab",' +
            "tabIndex:()=>" +
            current +
            "?0:-1," +
            '"aria-selected":()=>' +
            current +
            "," +
            "onKeyDown:this.bindFn(this.handleTablistKeyDown)," +
            "onTap:()=>this.updateCurrentTab(" +
            id +
            ")," +
            "children:" +
            translate +
            "(" +
            JSON.stringify(tabId(tab) + "-heading") +
            ")})]})"
        );
    }

    /**
     * A tab's body: an empty container that hands itself to the ui runtime, which is where
     * the render functions below take over. `otherwise` is what to draw when this tab is not
     * the open one - the next tab's test, and finally Desmos' own choice of body.
     *
     * The modal's controller goes along with it. It is the one thing a render function
     * cannot reach on its own - it is a prop of the component we are patching - and Saved
     * Graphs needs it to publish, so every tab is handed it.
     */
    function body(conditional, h, tab, otherwise) {
        return (
            conditional +
            "(()=>this.myGraphsController.getCurrentTab()===" +
            JSON.stringify(tabId(tab)) +
            ",{true:()=>" +
            h +
            '("div",{class:' +
            JSON.stringify("cde-tab cde-tab--" + tab.key) +
            ",didMount:(e)=>window.__desmosExt.ui.mount(" +
            JSON.stringify(tabId(tab)) +
            ",e,this.props.controller())," +
            "willUnmount:(e)=>window.__desmosExt.ui.unmount(e)})," +
            "false:()=>" +
            otherwise +
            "})"
        );
    }

    extension({
        id: "settings",

        /**
         * Add a tab, for the files in tabs/ to call at the top level. Safe to reach for
         * there, and only there: the manifest lists those files after this one, and an
         * extension's scripts run in the order it names them.
         */
        tab: function (def) {
            TABS.push(def);
        },

        patches: [
            // The headings, appended to the tablist after the "Examples" tab. Each `replace`
            // is a function rather than a string so that it is tabs() as it stands when the
            // bundle is patched that decides, not tabs() as it stood when this file loaded.
            {
                match: /(class:"dcg-my-graphs-modal__tab",children:)(\i)\((.*?),children:\(\)=>(this\.controller\.\i)(\("account-shell-heading-mygraphs-examples"\)}\)}\)}\))/,
                count: 1,
                replace: function (whole, prefix, h, args, translate, tail) {
                    return (
                        "\n" +
                        prefix +
                        h +
                        "(" +
                        args +
                        ",children:()=>" +
                        translate +
                        tail +
                        added()
                            .map(function (tab) {
                                return "," + heading(h, translate, tab);
                            })
                            .join("")
                    );
                }
            },
            // The heading labels.
            // TODO: move this to an api in the core plugin
            {
                match: /mq-narration-token = token(\n*)/,
                count: 1,
                replace: function (whole, trailing) {
                    return (
                        "mq-narration-token = token\n" +
                        added()
                            .map(function (tab) {
                                return tabId(tab) + "-heading = " + tab.label;
                            })
                            .join("\n") +
                        trailing
                    );
                }
            },
            // The body. The modal picks between the example gallery and the graph tiles; wrap
            // that choice in one of our own per tab, so the open tab gets the whole content
            // area to itself.
            {
                match: /(\i)\(\(\)=>this\.myGraphsController\.getCurrentTab\(\)==="example-graphs"(&&[^,]*,\{true:\(\)=>(\i)\(\i,\{controller:this\.props\.controller}\),false:\(\)=>\i\(\i,\{controller:this\.props\.controller}\)})\)/,
                replace: function (whole, conditional, rest, h) {
                    return tabs().reduceRight(
                        function (otherwise, tab) {
                            return body(conditional, h, tab, otherwise);
                        },
                        conditional +
                            '(()=>this.myGraphsController.getCurrentTab()==="example-graphs"' +
                            rest +
                            ")"
                    );
                }
            }
        ],

        main() {
            var ui = window.__desmosExt.ui;
            tabs().forEach(function (tab) {
                ui.slot(tabId(tab), tab.render);
                if (tab.main) tab.main();
            });
        }
    });
})();
