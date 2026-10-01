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
// Spelling is only half of it. A builtin whose arguments Lua already holds is arithmetic, so
// this file computes it too - see NUMERIC - and the answer is a number in a cell body and in an
// action body alike. Latex is what is left: an argument that is a fragment rather than a number,
// or a name with no JavaScript behind it. bridge.js makes that choice.
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

    // -----------------------------------------------------------------------
    // computing, rather than spelling
    // -----------------------------------------------------------------------

    /**
     * Desmos' functions as JavaScript, for when Lua already has the numbers.
     *
     * A builtin over values Lua holds is arithmetic, not a formula, and the answer is a number.
     * That matters most inside an action body, where there is nothing to park on: without this,
     * `floor(random()*100)` would be written down as latex and handed to Desmos to evaluate at
     * fire time - a different number every fire, and a formula where a value was asked for. It
     * matters outside one too, where it saves a round trip to a worker to be told what
     * `\floor(2.5)` is.
     *
     * Only where an argument is already a number. `sin(a)` with `a` a name the graph has not
     * priced yet still composes `\sin\left(a\right)`, which is the whole point of a fragment,
     * and the symbolic probe still writes `A\left(\right)=\sin\left(b\right)` rather than
     * today's arithmetic - a fragment argument never reaches this table.
     *
     * Not the whole list, on purpose. A function whose Desmos meaning is not one obvious line -
     * the distributions, `quantile`, `erf`, the colour spaces - is absent, and falls back to the
     * latex it always was. Absent here is a slower answer; wrong here would be a wrong one.
     */

    var DEG = Math.PI / 180;

    /**
     * Is the graph in degrees? Trig is the only thing that cares.
     *
     * `controller.graphSettings` and not `Calc.graphSettings`: the second is not a property of
     * the API object at all, so it read undefined on every graph and every angle here was a
     * radian - `sin(90)` on a degree-mode graph came back 0.894 rather than 1. ./items.js and
     * ./index.js both reach the settings the same way.
     */
    function degrees() {
        try {
            var settings =
                Calc && Calc.controller && Calc.controller.graphSettings;
            return !!(settings && settings.degreeMode);
        } catch (error) {
            return false;
        }
    }

    /** An angle on the way in to a trig function, and on the way out of an inverse. */
    function into(x) {
        return degrees() ? x * DEG : x;
    }
    function outof(x) {
        return degrees() ? x / DEG : x;
    }

    /**
     * Apply `fn` elementwise, the way a Desmos function is applied: `floor([1.5, 2.5])` is
     * `[1, 2]` and `mod([5, 6], 3)` is `[2, 0]`. Lists of different lengths are truncated to the
     * shortest, which is Desmos' own rule.
     */
    function map(fn, args) {
        var n = -1;
        args.forEach(function (arg) {
            if (!Array.isArray(arg)) return;
            n = n === -1 ? arg.length : Math.min(n, arg.length);
        });
        if (n === -1) return fn.apply(null, args);

        var out = [];
        for (var i = 0; i < n; i++)
            out.push(
                fn.apply(
                    null,
                    args.map(function (arg) {
                        return Array.isArray(arg) ? arg[i] : arg;
                    })
                )
            );
        return out;
    }

    /**
     * The numbers an aggregate is over. Desmos spells one both ways - `mean(1, 2, 3)` and
     * `mean(L)` - so both are taken, and a mix of the two is left to Desmos rather than guessed
     * at.
     */
    function flat(args) {
        if (args.length === 1 && Array.isArray(args[0]))
            return args[0].length ? args[0] : null;
        for (var i = 0; i < args.length; i++)
            if (Array.isArray(args[i])) return null;
        return args.length ? args : null;
    }

    function sum(v) {
        var t = 0;
        for (var i = 0; i < v.length; i++) t += v[i];
        return t;
    }

    function median(v) {
        var s = v.slice().sort(function (a, b) {
            return a - b;
        });
        var n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }

    /** `sample` is the n-1 divisor: Desmos' `var` and `stdev` against its `varp` and `stdevp`. */
    function spread(v, sample) {
        var n = v.length;
        if (n < (sample ? 2 : 1)) return NaN;
        var m = sum(v) / n;
        var s = 0;
        for (var i = 0; i < n; i++) s += (v[i] - m) * (v[i] - m);
        return s / (sample ? n - 1 : n);
    }

    /** Away from zero, not JavaScript's towards positive: Desmos rounds -2.5 to -3. */
    function round(x) {
        return x < 0 ? -Math.round(-x) : Math.round(x);
    }

    function gcd2(a, b) {
        if (!Number.isInteger(a) || !Number.isInteger(b)) return NaN;
        a = Math.abs(a);
        b = Math.abs(b);
        while (b) {
            var t = a % b;
            a = b;
            b = t;
        }
        return a;
    }

    function lcm2(a, b) {
        var g = gcd2(a, b);
        if (!g) return Number.isNaN(g) ? NaN : 0;
        return Math.abs((a / g) * b);
    }

    /** name -> function(jsArgs) -> { value } | null. Null means "not this way". */
    var NUMERIC = {};

    /** An entry of fixed arity, each argument mapped over if it is a list. */
    function fixed(count, fn) {
        return function (args) {
            return args.length === count ? { value: map(fn, args) } : null;
        };
    }

    [
        [
            "sin",
            function (x) {
                return Math.sin(into(x));
            }
        ],
        [
            "cos",
            function (x) {
                return Math.cos(into(x));
            }
        ],
        [
            "tan",
            function (x) {
                return Math.tan(into(x));
            }
        ],
        [
            "csc",
            function (x) {
                return 1 / Math.sin(into(x));
            }
        ],
        [
            "sec",
            function (x) {
                return 1 / Math.cos(into(x));
            }
        ],
        [
            "cot",
            function (x) {
                return 1 / Math.tan(into(x));
            }
        ],
        [
            "arcsin",
            function (x) {
                return outof(Math.asin(x));
            }
        ],
        [
            "arccos",
            function (x) {
                return outof(Math.acos(x));
            }
        ],
        [
            "arccsc",
            function (x) {
                return outof(Math.asin(1 / x));
            }
        ],
        [
            "arcsec",
            function (x) {
                return outof(Math.acos(1 / x));
            }
        ],
        // Desmos' arccot runs (0, pi), so it is pi/2 minus arctan rather than arctan of 1/x -
        // which would put arccot(-1) at -pi/4 instead of 3pi/4.
        [
            "arccot",
            function (x) {
                return outof(Math.PI / 2 - Math.atan(x));
            }
        ],
        ["sinh", Math.sinh],
        ["cosh", Math.cosh],
        ["tanh", Math.tanh],
        [
            "csch",
            function (x) {
                return 1 / Math.sinh(x);
            }
        ],
        [
            "sech",
            function (x) {
                return 1 / Math.cosh(x);
            }
        ],
        [
            "coth",
            function (x) {
                return 1 / Math.tanh(x);
            }
        ],
        ["arcsinh", Math.asinh],
        ["arccosh", Math.acosh],
        ["arctanh", Math.atanh],
        [
            "arccsch",
            function (x) {
                return Math.asinh(1 / x);
            }
        ],
        [
            "arcsech",
            function (x) {
                return Math.acosh(1 / x);
            }
        ],
        [
            "arccoth",
            function (x) {
                return Math.atanh(1 / x);
            }
        ],
        ["exp", Math.exp],
        ["ln", Math.log],
        ["abs", Math.abs],
        ["floor", Math.floor],
        ["ceil", Math.ceil],
        ["sqrt", Math.sqrt],
        ["sign", Math.sign],
        ["signum", Math.sign],
        ["sgn", Math.sign]
    ].forEach(function (pair) {
        NUMERIC[pair[0]] = fixed(1, pair[1]);
    });

    /** Desmos' mod takes the sign of the divisor, so `mod(-1, 3)` is 2. */
    NUMERIC.mod = fixed(2, function (a, b) {
        return a - b * Math.floor(a / b);
    });

    /** One argument is the angle; two are a y and an x, and the quadrant comes out right. */
    NUMERIC.arctan = function (args) {
        if (args.length === 1)
            return {
                value: map(function (x) {
                    return outof(Math.atan(x));
                }, args)
            };
        if (args.length === 2)
            return {
                value: map(function (y, x) {
                    return outof(Math.atan2(y, x));
                }, args)
            };
        return null;
    };

    /** `log(x)` is base ten; the second argument is the base, as the subscript is. */
    NUMERIC.log = function (args) {
        if (args.length === 1) return { value: map(Math.log10, args) };
        if (args.length === 2)
            return {
                value: map(function (x, b) {
                    return Math.log(x) / Math.log(b);
                }, args)
            };
        return null;
    };

    /** A second argument is a number of decimal places. */
    NUMERIC.round = function (args) {
        if (args.length === 1) return { value: map(round, args) };
        if (args.length === 2)
            return {
                value: map(function (x, places) {
                    var p = Math.pow(10, places);
                    return round(x * p) / p;
                }, args)
            };
        return null;
    };

    /** The ones over a whole list: `mean(1, 2, 3)` and `mean(L)` alike. See flat(). */
    function aggregate(names, fn) {
        names.split(" ").forEach(function (name) {
            NUMERIC[name] = function (args) {
                var v = flat(args);
                return v ? { value: fn(v) } : null;
            };
        });
    }

    aggregate("total", sum);
    aggregate("mean", function (v) {
        return sum(v) / v.length;
    });
    aggregate("median", median);
    // Reduced rather than Math.min.apply: a Lua list can be long enough to overflow a call.
    aggregate("min", function (v) {
        return v.reduce(function (a, b) {
            return Math.min(a, b);
        });
    });
    aggregate("max", function (v) {
        return v.reduce(function (a, b) {
            return Math.max(a, b);
        });
    });
    aggregate("count length", function (v) {
        return v.length;
    });
    aggregate("stdev stddev stdDev", function (v) {
        return Math.sqrt(spread(v, true));
    });
    aggregate("stdevp stddevp stdDevP", function (v) {
        return Math.sqrt(spread(v, false));
    });
    aggregate("var variance", function (v) {
        return spread(v, true);
    });
    aggregate("varp", function (v) {
        return spread(v, false);
    });
    aggregate("gcd mcd gcf", function (v) {
        return v.reduce(gcd2);
    });
    aggregate("lcm mcm", function (v) {
        return v.reduce(lcm2);
    });

    NUMERIC.sort = function (args) {
        if (args.length !== 1 || !Array.isArray(args[0])) return null;
        return {
            value: args[0].slice().sort(function (a, b) {
                return a - b;
            })
        };
    };

    NUMERIC.shuffle = function (args) {
        if (args.length !== 1 || !Array.isArray(args[0])) return null;
        var v = args[0].slice();
        for (var i = v.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = v[i];
            v[i] = v[j];
            v[j] = t;
        }
        return { value: v };
    };

    /** `join(1, L, 2)` is one list of all of it, lists spliced in rather than nested. */
    NUMERIC.join = function (args) {
        if (!args.length) return null;
        var out = [];
        args.forEach(function (arg) {
            if (Array.isArray(arg)) out.push.apply(out, arg);
            else out.push(arg);
        });
        return { value: out };
    };

    /**
     * `random()` is one number in [0, 1) and `random(n)` is n of them.
     *
     * A seed is Desmos' own generator and nothing here would reproduce it, so `random(n, s)`
     * falls through to the latex - where Desmos answers it, and answers it the same way twice.
     */
    NUMERIC.random = function (args) {
        if (!args.length) return { value: Math.random() };
        if (
            args.length === 1 &&
            Number.isInteger(args[0]) &&
            args[0] >= 1 &&
            args[0] <= 10000
        ) {
            var out = [];
            for (var i = 0; i < args[0]; i++) out.push(Math.random());
            return { value: out };
        }
        return null;
    };

    lua.builtins = {
        init: init,
        has: has,
        latex: latex,
        compute: compute,
        value: value,
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

    /**
     * Desmos' own evaluator, synchronously, on this thread: `\\sqrt{9}` -> 3.
     *
     * `Desmos.Private.Fragile.evaluateLatex(latex, degreeMode)` is what the calculator itself
     * uses for a slider's bounds, which have to be known before a frame can be drawn. It
     * evaluates in a *base* frame - every function Desmos has, and none of the graph's names -
     * which is exactly the closed-form case, and is why the call sites here have to know their
     * arguments are numbers before they reach it.
     *
     * Undefined rather than NaN when there is no answer, because NaN is one: it is what a
     * list-valued or point-valued expression coerces to (the calculator's own wrapper ends in a
     * unary plus), and it is what `\\sqrt{-1}` is worth. Either way the caller has somewhere else
     * to go.
     *
     * "Fragile" is Desmos' own word for that namespace. A build that moves it costs the table
     * below rather than a wrong answer.
     */
    function evaluate(latex) {
        var D = typeof window !== "undefined" ? window.Desmos : null;
        var fn =
            D &&
            D.Private &&
            D.Private.Fragile &&
            D.Private.Fragile.evaluateLatex;
        if (typeof fn !== "function") return undefined;
        try {
            var v = fn(latex, degrees());
            return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * What `name(args)` is worth, given that every argument is a number Lua already holds.
     * `latex` is the same call spelled out, which is what Desmos' evaluator takes.
     *
     * Desmos answers first, because its arithmetic is the arithmetic that matters and it knows
     * every function rather than the few below. The table is what is left: the list-valued ones,
     * which the evaluator coerces to NaN, and `random`, which in a frame with no graph behind it
     * has no seed to roll from - a "random" that came back the same every call would be the bug
     * this was written to fix.
     */
    function compute(name, args, latex) {
        if (!has(name)) return null;

        if (name !== "random" && typeof latex === "string") {
            var v = evaluate(latex);
            if (v !== undefined) return { value: v };
        }
        return value(name, args);
    }

    /**
     * The table alone: `("floor", [2.5])` -> `{ value: 2 }`. Null for a name it does not have, or
     * an argument count Desmos spells differently.
     *
     * Wrapped in an object so a result of `null` - which nothing returns, but an added entry
     * might - stays distinguishable from "not this way".
     */
    function value(name, args) {
        if (!has(name)) return null;
        var fn = NUMERIC[name];
        if (!fn) return null;
        try {
            return fn(args) || null;
        } catch (error) {
            return null;
        }
    }

    /** Every builtin name, for the editor's completion list. */
    function names() {
        return Object.keys(index());
    }
})();
