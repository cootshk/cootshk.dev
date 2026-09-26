// This plugin uses code from https://chromewebstore.google.com/detail/desmos-mobile-helper/iameifhjgjpknbonmkcglfnahbcfldnl.

// letters
const LOWER = ["αβγδεζθκ", "λμξπρστυ", "φχψωϕ"];
const UPPER = ["ιϑΓΔϵηΘϰ", "ΛνΞΠϱΣςΥ", "ΦϜΨϖ∞"];

// letter -> latex
const LATEX = {
    α: "\\alpha",
    β: "\\beta",
    γ: "\\gamma",
    δ: "\\delta",
    ε: "\\varepsilon",
    ζ: "\\zeta",
    θ: "\\theta",
    κ: "\\kappa",
    λ: "\\lambda",
    μ: "\\mu",
    ξ: "\\xi",
    π: "\\pi",
    ρ: "\\rho",
    σ: "\\sigma",
    τ: "\\tau",
    υ: "\\upsilon",
    φ: "\\varphi",
    χ: "\\chi",
    ψ: "\\psi",
    ω: "\\omega",
    ϕ: "\\phi",
    ι: "\\iota",
    ϑ: "\\vartheta",
    Γ: "\\Gamma",
    Δ: "\\Delta",
    ϵ: "\\epsilon",
    η: "\\eta",
    Θ: "\\Theta",
    ϰ: "\\varkappa",
    Λ: "\\Lambda",
    ν: "\\nu",
    Ξ: "\\Xi",
    Π: "\\Pi",
    ϱ: "\\varrho",
    Σ: "\\Sigma",
    ς: "\\varsigma",
    Υ: "\\Upsilon",
    Φ: "\\Phi",
    Ϝ: "\\digamma",
    Ψ: "\\Psi",
    ϖ: "\\varpi",
    "∞": "\\infty"
};

const dcg = {};

const pages = new Map();

let Calc = null;

const focused = () =>
    Calc && Calc.focusedMathQuill && Calc.focusedMathQuill.mq
        ? Calc.focusedMathQuill
        : null;

const row = (children) => dcg.h("div", { class: "dcg-keypad-row", children });

const letter = (view, char) =>
    dcg.latexKey({ content: LATEX[char], typedText: char })(
        char,
        view.dispatch,
        {},
        view
    );

const action = (spec) =>
    dcg.h(dcg.Button, {
        command: dcg.konst(spec.label),
        ariaLabel: dcg.konst(spec.label),
        colspan: dcg.konst(spec.colspan || 1),
        style: dcg.konst("highlight"),
        onTap: spec.tap,
        children: spec.icon
            ? dcg.h("i", {
                  class: "dcg-icon-" + spec.icon,
                  "aria-hidden": "true"
              })
            : spec.text
    });

function controls(view) {
    const press = (key) =>
        view.dispatch({ type: "keypad/press-key", key, source: "keypad" });

    return [
        dcg.stockKey(view, "123", { colspan: 1.5, style: "highlight" }),
        action({
            label: "Select left",
            icon: "chevron-left",
            colspan: 0.8,
            tap: () => press("Shift-Left")
        }),
        action({
            label: "Select right",
            icon: "chevron-right",
            colspan: 0.8,
            tap: () => press("Shift-Right")
        }),
        action({
            label: "Space",
            text: "␣",
            colspan: 0.8,
            tap: () => view.dispatch({ type: "keypad/type-text", text: " " })
        }),
        action({ label: "Select all", text: "All", tap: selectAll }),
        action({ label: "Copy", icon: "duplicate", tap: copy }),
        action({ label: "Paste", icon: "insert", tap: paste }),
        dcg.stockKey(view, "enter", { colspan: 1.5, style: "blue" })
    ];
}

function page(capitals) {
    const rows = capitals ? UPPER : LOWER;

    return class extends dcg.Keypad {
        template() {
            return dcg.h("div", {
                class: "dcg-basic-keypad dcg-do-not-blur",
                children: [
                    row([...rows[0]].map((char) => letter(this, char))),
                    row([...rows[1]].map((char) => letter(this, char))),
                    row([
                        // desmos default shift key
                        dcg.stockKey(this, "shift", {
                            colspan: 1.5,
                            style: capitals ? "blue" : "highlight"
                        }),
                        ...[...rows[2]].map((char) => letter(this, char)),
                        dcg.stockKey(this, "backspace", {
                            colspan: 1.5,
                            style: "highlight"
                        })
                    ]),
                    row(controls(this))
                ]
            });
        }
    };
}

function copy() {
    const field = focused();
    if (!field) return;

    const selection = field.mq.selection();
    const latex =
        selection.latex.slice(selection.startIndex, selection.endIndex) ||
        field.mq.latex();
    if (latex)
        navigator.clipboard
            .writeText(latex)
            .catch((error) =>
                console.error("betterKeypad: copy failed", error)
            );
}

function paste() {
    navigator.clipboard
        .readText()
        .then((text) => {
            const field = focused();
            if (!field) return;
            field.mq.write(text);
            // update mathquill
            Calc.controller.dispatch({ type: "keypad/type-text", text: "" });
        })
        .catch((error) => console.error("betterKeypad: paste failed", error));
}

function selectAll() {
    const field = focused();
    if (field) field.mq.select();
}

extension({
    id: "betterKeypad",

    patches: [
        // latex key factory
        {
            match: /function (\i)\(\i\)\{return\(\i,\i,\i=\{},\i\)=>(\i)\((\i),\{command:(\i)\(\i\.command\|\|\i\),[\s\S]*?text:\i\.typedText\|\|\i}\),[\s\S]*?latex:\4\(\i\.content\|\|\i\)}\)}\)}/,
            replace: "$&$self.keys($1,$2,$3,$4);",
            count: 1
        },
        {
            match: /function (\i)\(\i,\i,\i=\{}\)\{let \i=\i\.dispatch;return \i\[\i]\(\i,\i,\i,\i\)}function \i\(\i=1\)\{return \i\("div",\{style:\i\(`flex-grow:\$\{\i}`\)}\)}var (\i)=class extends \i\{constructor\(\)\{super\(\.\.\.arguments\);[\s\S]*?};/,
            replace: "$&$self.base($1,$2);",
            count: 1
        },

        // extra layout pages
        {
            match: /\i\(\(\)=>this\.controller\.getKeypadLayout\(\),\{letters:\(\)=>(\i)\(\i,\{controller:this\.props\.controller\}\),/,
            replace:
                "$&greek:()=>$1($self.page(!1),{controller:this.props.controller})," +
                "greekCapitals:()=>$1($self.page(!0),{controller:this.props.controller}),",
            count: 1
        },
        // Shift, which is a map from a layout to the one above it.
        {
            match: /case"noQwertyCapitalLetters":return"noQwertyLetters";/,
            replace:
                '$&case"greek":return"greekCapitals";case"greekCapitals":return"greek";',
            count: 1
        },
        // "keypad/greek" beside the "keypad/abc" that opens the letters page.
        {
            match: /case"keypad\/abc":this\.isQwertyKeyboardEnabled\(\)/,
            replace:
                'case"keypad/greek":this.setKeypadLayout("greek");break;$&',
            count: 1
        },
        {
            match: /case"keypad\/123":case"keypad\/abc":case"keypad\/audio":/,
            replace: 'case"keypad/greek":$&',
            count: 1
        },

        // button in the default keypad
        {
            match: /(\i)\((\i),\{command:this\.const\("ABC"\),[\s\S]*?raw\("A B C"\)\}\)/,
            replace:
                '$&,$1($2,{command:this.const("greek"),ariaLabel:this.const("Greek keypad"),' +
                'colspan:this.const(1),style:this.const("highlight"),' +
                'onTap:()=>{this.dispatch({type:"keypad/greek"})},children:$self.alpha()})',
            count: 2
        }
    ],

    keys(latexKey, h, Button, konst) {
        Object.assign(dcg, { latexKey, h, Button, konst });
    },

    base(stockKey, Keypad) {
        Object.assign(dcg, { stockKey, Keypad });
    },

    alpha() {
        return dcg.h("span", {
            class: "dcg-mq-math-mode dcg-static-mathquill-view",
            children: dcg.h("span", {
                class: "dcg-mq-root-block",
                children: dcg.h("var", { children: "α" })
            })
        });
    },

    page(capitals) {
        if (!pages.has(capitals)) pages.set(capitals, page(capitals));
        return pages.get(capitals);
    },

    ready(calc) {
        Calc = calc;
    }
});
