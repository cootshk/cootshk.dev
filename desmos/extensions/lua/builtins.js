// Desmos' own functions, as Lua spells them: `arctan` is `Desmos.arctan`.
//
// The list is not written down here. Desmos already keeps one - MathQuill's
// `autoOperatorNames`, the set of words a math field turns into operators as you type - and
// extensions/matrices reaches it the same way this does, by wrapping
// Calc.controller.getMathquillConfig. Taking it live rather than copying it means the table does
// not go stale on a Desmos deploy, a geometry graph gets the geometry functions, and the names
// extensions/matrices appends come along for free because its wrapper is already in the chain.
//
// The latex spelling is derived rather than tabulated, because MathQuill's own rule is simple:
// a name LaTeX has a command for is `\name`, and everything else is `\operatorname{name}`. That
// set is LaTeX's rather than Desmos', which is what makes it safe to write down - see COMMANDS.
// So `sin` is `\sin` and `arccsc`, `csch`, `mod`, `floor` and `total` are `\operatorname{...}`
// without anyone deciding case by case.
//
// A builtin is a *number* in ordinary cell code - one trip to the evaluator, parking the cell
// exactly as calling a graph function does - and a latex fragment inside an action body, where
// there is nothing to park on and Desmos evaluates the right-hand side itself. bridge.js makes
// that choice; this file only spells things.
//
// Part of extensions/lua; ./index.js registers the object this hangs itself off.
(function () {
    var lua = window.Extensions.lua;

    /**
     * Names LaTeX has a command for, so `\sin` rather than `\operatorname{sin}`. Straight out of
     * the bundle's MathQuill setup, which builds `BuiltInOpNames` from exactly these two lines.
     */
    var COMMANDS = {};
    (
        "arg deg det dim exp gcd hom inf ker lg lim ln log max min sup limsup liminf injlim " +
        "projlim Pr " +
        "sin cos tan arcsin arccos arctan sinh cosh tanh sec csc cot coth"
    )
        .split(" ")
        .forEach(function (name) {
            COMMANDS[name] = true;
        });

    /**
     * In the operator list but not functions: `and`, `or`, `for`, `with` and `repeat` are
     * Desmos' syntax - and most of them are Lua keywords besides, so they could only ever have
     * been reached as `Desmos["and"]`. `width`, `height` and `tone` are not values a cell can ask
     * for either.
     */
    var SKIP = {};
    "for with and or repeat width height tone"
        .split(" ")
        .forEach(function (name) {
            SKIP[name] = true;
        });

    /**
     * The handful the rule above cannot spell, because they are not `name(args)` shaped. None of
     * these are in `autoOperatorNames` - MathQuill has them as commands of its own - so they are
     * additions to the live list rather than corrections of it.
     */
    var SPECIAL = {
        sqrt: function (args) {
            return args.length === 1 ? "\\sqrt{" + args[0] + "}" : null;
        },
        nthroot: function (args) {
            return args.length === 2
                ? "\\sqrt[" + args[0] + "]{" + args[1] + "}"
                : null;
        },
        abs: function (args) {
            return args.length === 1 ? "\\left|" + args[0] + "\\right|" : null;
        },
        log: function (args) {
            // Desmos writes a base as a subscript, and `log(x)` is base ten.
            if (args.length === 1) return "\\log\\left(" + args[0] + "\\right)";
            if (args.length === 2)
                return "\\log_{" + args[1] + "}\\left(" + args[0] + "\\right)";
            return null;
        },
        random: function (args) {
            // The only one that is legal with no arguments at all.
            if (!args.length) return "\\operatorname{random}";
            return (
                "\\operatorname{random}\\left(" + args.join(",") + "\\right)"
            );
        }
    };

    /**
     * Where the live list is unavailable - before Desmos has started, and in the offline test -
     * this stands in. It is the bundle's own base list, which is the part that does not depend on
     * the graph being a geometry or 3D one, so a fallback is a smaller list rather than a wrong
     * one.
     */
    var FALLBACK = (
        "exp ln log " +
        "total length count mean median quantile quartile nCr nPr stats " +
        "stdev stddev stdDev stdevp stddevp stdDevP mad var varp variance cov covp corr " +
        "spearman " +
        "lcm mcm gcd mcd gcf mod ceil floor round abs min max sign signum sgn " +
        "sin cos tan csc sec cot " +
        "sinh cosh tanh csch sech coth " +
        "arcsin arccos arctan arccsc arcsec arccot " +
        "arcsinh arccosh arctanh arccsch arcsech arccoth " +
        "polygon distance midpoint sort shuffle join unique erf " +
        "normaldist tdist poissondist binomialdist uniformdist chisqdist geodist " +
        "pdf cdf random inverseCdf inversecdf " +
        "rgb hsv okhsv oklab oklch"
    ).split(" ");

    /** name -> true, rebuilt whenever the operator list changes under us. */
    var known = null;

    /** The string the list was built from, so a re-read is free when nothing has moved. */
    var seen = null;

    var Calc = null;

    lua.builtins = {
        init: init,
        has: has,
        latex: latex,
        names: names
    };

    function init(calc) {
        Calc = calc;
        known = null;

        // Wrapped rather than called once, in the shape extensions/matrices uses: an extension
        // loaded after this one can still append to the list, and we see what it appended.
        var controller = Calc && Calc.controller;
        if (!controller || typeof controller.getMathquillConfig !== "function")
            return;

        var original = controller.getMathquillConfig;
        controller.getMathquillConfig = function (options) {
            var config = original.call(controller, options);
            if (config && typeof config.autoOperatorNames === "string")
                take(config.autoOperatorNames);
            return config;
        };
    }

    /**
     * The name index, built on first use.
     *
     * Asked of Desmos rather than remembered, because the answer depends on the graph: a
     * geometry graph has the geometry functions in it. FALLBACK stands in only where there is
     * nothing to ask - before Desmos has started, and in the offline test.
     */
    function index() {
        if (known) return known;

        if (Calc && Calc.controller)
            try {
                var config = Calc.controller.getMathquillConfig({});
                if (config && typeof config.autoOperatorNames === "string") {
                    take(config.autoOperatorNames);
                    return known;
                }
            } catch (error) {
                // A Desmos that has moved this, or one that is not up yet.
            }

        take(FALLBACK.join(" "));
        return known;
    }

    /**
     * Index an `autoOperatorNames` string, if it is not the one already indexed.
     *
     * An entry is `name|narration-key`, not a bare name - MathQuill wants somewhere to hang the
     * word a screen reader says, so Desmos writes `arccosh|mq-narration-op-arccosh` and the name
     * is the half in front of the pipe. Not every entry has one, and the names
     * `extensions/matrices` appends have none at all, so the split has to tolerate both.
     */
    function take(operators) {
        if (operators === seen && known) return;
        seen = operators;
        known = {};
        operators.split(/\s+/).forEach(function (entry) {
            var name = entry.split("|")[0];
            if (name && !SKIP[name]) known[name] = true;
        });
        // The shaped few are MathQuill commands rather than operator names, so they are
        // additions to the live list rather than corrections of it.
        Object.keys(SPECIAL).forEach(function (name) {
            known[name] = true;
        });
    }

    /** Is this a name Desmos would turn into an operator? */
    function has(name) {
        return typeof name === "string" && index()[name] === true;
    }

    /**
     * `("arctan", ["1"])` -> `\arctan\left(1\right)`. Null when the name is not a builtin, or
     * when it is one of the shaped few and the argument count is wrong.
     */
    function latex(name, args) {
        if (!has(name)) return null;
        if (SPECIAL[name]) return SPECIAL[name](args);
        var head = COMMANDS[name]
            ? "\\" + name
            : "\\operatorname{" + name + "}";
        return head + "\\left(" + args.join(",") + "\\right)";
    }

    /** Every builtin name, for the editor's completion list. */
    function names() {
        return Object.keys(index());
    }
})();
