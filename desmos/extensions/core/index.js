(function () {
    /** The mode a Desmos product belongs to, falling back to the one this page loaded as. */
    function modeOf(product) {
        return modeForProduct(product) || mode;
    }

    extension({
        id: "core",

        /** Desmos' Graph.getURL(): where a graph of `product` lives on this site. */
        url(product, graph) {
            return pageUrl(modeOf(product), graph);
        },

        /**
         * Leave for another calculator. Desmos' own buttons destroy its API and build a new
         * one in place, which keeps the extensions and bundle patches of the calculator the
         * page started as - so do it as a real load instead.
         */
        open(product, graph) {
            navigateTo(modeOf(product), graph);
        },

        patches: [
            // saved graph parsing
            {
                match: /getGraphHashInUrl\(\)\{[^{}]*}/,
                replace:
                    'getGraphHashInUrl(){return location.hash.replace(/^#\\/?/,"").trim()||void 0}',
                count: 1
            },
            {
                match: /getURL\(\{includeHashForRecovery:(\i)\}=\{includeHashForRecovery:!1\}\)\{/,
                replace:
                    "$&return $self.url(this.product," +
                    "(!this.recovery||$1)&&this.hash?this.hash:void 0);",
                count: 1
            },
            {
                match: /(\i)&&\(window\.location\.search&&\(\1\+=window\.location\.search\),/,
                replace: "$1&&(",
                count: 1
            },
            {
                match: /(let (\i)=\i\.getURL\(\))\+window\.location\.search;/,
                replace: "$1;",
                count: 1
            },
            // Opening a saved or example graph that belongs to another calculator.
            {
                match: /case"fetch-and-open-graph":\{let (\i)=this\.graphsController\.graphCache\.getGraph\(\i\.graphId\);if\(!\1\)break;/,
                replace:
                    "$&if($1.product!==this.product)" +
                    "return void $self.open($1.product,$1.hash);",
                count: 1
            },
            // tool menu & my graphs modal
            {
                match: /let \i=(\i)\.product===this\.product,/,
                replace:
                    "if($1.product!==this.product)" +
                    "return void $self.open($1.product);$&",
                count: 1
            },
            // Remove the login button on the topbar
            {
                match: /false:\(\)=>(\i)\("span",\{class:"dcg-login",(.*?)"account-shell-button-sign-up"\)([^\]]*?)]}\)/,
                replace: "false: ()=>$1('span', {class:'dcg-login'})",
                count: 1
            },
            // Login prompt in the expressions sheet
            {
                match: /this.isDismissedNotice\("authenticate"\)\)return"authenticate";/,
                replace: "false && $&",
                count: 1
            },
            // disable bugsnag
            {
                match: /return \i\._setDelivery\(window\.XDomainRequest\?\i:\i\),\i\._logger\.debug\("Loaded!"\),\i\.leaveBreadcrumb\("Bugsnag loaded",\{},"state"\)/,
                replace: "return; $&",
                count: 1
            },
            {
                match: /this\.bugsnagClient\.(\i)/,
                replace: "this.bugsnagClient?.$1"
            }
        ],

        ready() {
            console.log("Started extensions!");
        }
    });
})();
