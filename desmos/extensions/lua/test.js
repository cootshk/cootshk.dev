// What can be checked without a browser: the Lua half of this extension, against the real
// fengari-web bundle out of cdn/ and a stub Calc. editor.js is left out - it wants a DOM and
// Monaco - so what this covers is bridge.js and runner.js, which is where the C-API calls and
// the coroutine machinery live, and where a mistake is hardest to see by reading.
//
//     node desmos/extensions/lua/test.js
//
// Not loaded in the browser: extensions.json lists the four files an extension is made of, and
// this is not one of them.
//
// The stub Calc hands a HelperExpression its value on a timer, which is the point - a cell that
// reads `a` before the evaluator has said what `a` is has to park and be resumed, and that is
// the one thing here that would be easy to get quietly wrong.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../../..");

// --- the page ------------------------------------------------------------------
// window first: fengari-web is a UMD bundle and takes `window` as its global object.
global.window = {
    Extensions: {},
    addEventListener: () => {},
    __desmosExt: { ui: { el: () => ({}) } }
};
global.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};
global.MutationObserver = class {
    observe() {}
};
global.window.window = global.window;
// fengari-web only installs its <script type="application/lua"> machinery when it believes it
// is in a browser: `document instanceof HTMLDocument`. Give it a constructor our stub is not
// an instance of, and it loads the VM and skips the DOM half.
global.HTMLDocument = function HTMLDocument() {};
try {
    global.window.fengari = require(path.join(ROOT, "cdn/fengari-web.js"));
} catch (e) {
    console.error("loading fengari failed:", e.message);
    console.error((e.stack || "").split("\n").slice(1, 5).join("\n"));
    process.exit(2);
}
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.performance = { now: () => Date.now() };

let captured = null;
// Mirrors extensions.js:89-97: the def goes on the window under its id, which is how
// bridge.js/runner.js/editor.js find the object index.js registered.
global.extension = (def) => {
    captured = def;
    global.window.Extensions[def.id] = def;
};

// --- a stub Calc ---------------------------------------------------------------
// Values arrive on a timer, which is the whole point: it forces the yield/resume path.
// Names *and* items. A read is only answered for a name the graph defines - that is what the
// definitions index is for - so a value the harness offers without an item behind it would read
// nil, exactly as it would in the calculator.
const GRAPH = { a: 5, b: 3, L: [1, 2, 3], f: (x) => x * x, S: 42 };
const SEED = [
    { type: "expression", id: "g1", latex: "a=5" },
    { type: "expression", id: "g2", latex: "b=3" },
    { type: "expression", id: "g3", latex: "L=\\left[1,2,3\\right]" },
    { type: "expression", id: "g4", latex: "f\\left(x\\right)=x^{2}" },
    // Read by exactly one test, which needs a name whose helper is not warm yet.
    { type: "expression", id: "g5", latex: "S=42" }
];
const observers = [];
let selected = null;
const dispatched = [];
let reparsed = 0;
// What Calc.observeEvent("change.cdeLua") would fire. Rescanning is how index.js notices a
// note that has appeared, so the harness has to do it the same way the graph would.
const change = () => observers.forEach((cb) => cb());
let list = SEED.slice();
const helpers = [];

const Calc = {
    // Desmos hands back a copy, and convert()/add() edit the copy before setting it back - so
    // the stub has to copy the items too, or a test would pass on a mutation Desmos would not
    // have kept.
    getState: () => ({
        expressions: { list: list.map((i) => Object.assign({}, i)) }
    }),
    setExpression(spec) {
        const at = list.findIndex((i) => i.id === spec.id);
        if (at === -1) list.push(Object.assign({}, spec));
        else list[at] = Object.assign({}, list[at], spec);
    },
    removeExpression({ id }) {
        list = list.filter((i) => i.id !== id);
    },
    // convert() and add() replace an item with one of another type, which setExpression cannot
    // do (it dispatches set-expression-properties-from-api against the model already there),
    // so they go through setState - and so must the stub.
    setState(state) {
        list = state.expressions.list.map((i) => Object.assign({}, i));
    },
    observeEvent: (name, cb) => {
        observers.push(cb);
    },
    unobserveEvent: () => {},
    controller: {
        generateId: () => String(++idc),
        // What scan() reads: the live models, which unlike getState() have no cache lag.
        getAllItemModels: () => list,
        getSelectedItem: () => selected,
        dispatch: (action) => dispatched.push(action),
        // Exports reach the graph only through Desmos' parse, which calls lua.inject().
        requestParseForAllItems: () => {
            reparsed++;
        }
    },
    HelperExpression({ latex }) {
        const h = { numericValue: NaN, listValue: undefined, _cbs: [] };
        h.observe = (_k, cb) => h._cbs.push(cb);
        h.unobserveAll = () => {
            h._cbs = [];
        };
        helpers.push({ latex, h });
        setTimeout(() => {
            report(h, evaluate(latex));
        }, 10);
        return h;
    }
};

/** `a` -> 5, `a_{b}` -> GRAPH.a_b, `f\left(3\right)` -> 9, anything else -> NaN. */
function evaluate(latex) {
    const call = /^([A-Za-z])(?:_\{(\w+)\})?\\left\((.*)\\right\)$/.exec(latex);
    if (call) {
        const fn = GRAPH[call[1] + (call[2] || "")];
        if (typeof fn !== "function") return NaN;
        const arg = literal(call[3]);
        // Desmos functions take lists, which is the whole reason one call can stand for many.
        return Array.isArray(arg) ? arg.map(fn) : fn(arg);
    }
    const v = GRAPH[latex.replace(/_\{(\w+)\}/g, "_$1")];
    return typeof v === "function" ? NaN : v === undefined ? NaN : v;
}

/** A latex argument back into a JS value: a number, or a list of them. */
function literal(src) {
    const listed = /^\\left\[(.*)\\right\]$/.exec(src);
    if (listed) return listed[1].split(",").map(Number);
    return Number(src);
}

function report(h, v) {
    if (Array.isArray(v)) h.listValue = v;
    else h.numericValue = v;
    h._cbs.forEach((cb) => cb());
}

/** Change a graph value and tell whatever is watching it, the way the evaluator would. */
function poke(name, value) {
    GRAPH[name] = value;
    helpers.forEach((e) => {
        const plain = e.latex.replace(/_\{(\w+)\}/g, "_$1");
        if (plain === name || plain.indexOf(name + "\\left(") === 0)
            report(e.h, evaluate(e.latex));
    });
}
let idc = 100;

// --- load the extension -------------------------------------------------------
for (const f of ["index.js", "bridge.js", "runner.js"]) {
    const src = fs.readFileSync(
        path.join(ROOT, "desmos/extensions/lua", f),
        "utf8"
    );
    // Run in this scope so `extension`, `window` and friends are the ones above.
    new Function(
        "window",
        "document",
        "extension",
        "MutationObserver",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "console",
        src
    )(
        global.window,
        global.document,
        global.extension,
        global.MutationObserver,
        global.requestAnimationFrame,
        global.cancelAnimationFrame,
        console
    );
}
const lua = window.Extensions.lua;

// --- drive it -----------------------------------------------------------------
let fails = 0;
function ok(name, cond, extra) {
    console.log(
        (cond ? "  PASS  " : "  FAIL  ") + name + (cond ? "" : "   <- " + extra)
    );
    if (!cond) fails++;
}
/**
 * What Desmos would be handed for `name`. Exports are not items any more - they go straight
 * into the parsable-object map the evaluator is built from - so this asks lua.inject() the same
 * way the patched bundle does.
 */
/** The whole map lua.inject() would hand Desmos' parse. */
function injected() {
    const map = {};
    lua.inject(map);
    return map;
}

/** The latex Desmos would be given for `name`, or undefined. */
function exported(name) {
    const map = injected();
    const id = Object.keys(map).find((k) => k.endsWith("-" + name));
    return id && map[id].latex;
}

/** Put the line-2 syntax error back, to check line() reads it. */
function syntaxOf(cell) {
    const save = cell.source;
    cell.source = "local x = 1\nlocal y = = 2";
    const bad = lua.runner.check(cell);
    cell.source = save;
    return bad;
}

/**
 * A cell on the graph. `text` is the Lua source verbatim; pragmas ride on an optional first
 * line, which stays in the source because it is a Lua comment.
 */
function cellWith(source, pragmas) {
    const id = String(++idc);
    const head =
        pragmas && pragmas.length ? "--!lua " + pragmas.join(" ") + "\n" : "";
    list.push({ type: "text", id, text: head + source, lua: true });
    return id;
}

async function main() {
    captured.ready(Calc);
    ok("ready() survived", !!lua.bridge && !!lua.runner);

    // 1. value -> latex, with no graph reads at all
    let id = cellWith(
        [
            "Desmos.k = 42",
            "Desmos.v = {1, 2, 3}",
            "Desmos.p = {x = 1, y = 2}",
            "Desmos.t = 1e-7",
            "Desmos.i = math.huge"
        ].join("\n")
    );
    change();
    let cell = lua.cell(id);
    ok("cell discovered", !!cell, "not found");
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok("number", exported("k") === "k=42", exported("k"));
    ok("list", exported("v") === "v=\\left[1,2,3\\right]", exported("v"));
    ok("point", exported("p") === "p=\\left(1,2\\right)", exported("p"));
    ok("sci notation", exported("t") === "t=1\\cdot10^{-7}", exported("t"));
    ok("infinity", exported("i") === "i=\\infty", exported("i"));
    ok("no error", !cell.error, cell.error);

    // 2. THE BIG ONE: reading a Desmos value that is not there yet must park and resume
    id = cellWith("Desmos.c = a * 2 + b");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    ok("parked on a cold read", cell.parked === true, "parked=" + cell.parked);
    await new Promise((r) => setTimeout(r, 80));
    ok(
        "resumed and computed (a*2+b = 13)",
        exported("c") === "c=13",
        exported("c")
    );
    ok(
        "recorded its reads",
        cell.reads.has("a") && cell.reads.has("b"),
        [...cell.reads].join(",")
    );

    // 3. a list-valued read
    id = cellWith(
        "local s = 0\nfor _, x in ipairs(L) do s = s + x end\nDesmos.s = s"
    );
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 80));
    ok(
        "list read (1+2+3 = 6)",
        exported("s") === "s=6",
        exported("s") + " err=" + cell.error
    );

    // 4. the reaper is Desmos' own diff: an export that stops being made is simply absent
    lua.edited(cell.id, "Desmos.s = 1");
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok("reaped nothing to reap", exported("s") === "s=1", exported("s"));
    lua.edited(cell.id, "-- nothing");
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "export reaped when it stops being made",
        exported("s") === undefined,
        exported("s")
    );

    // 5. errors
    id = cellWith("Desmos.q = nope()");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "runtime error captured",
        !!cell.error && /nil value/.test(cell.error),
        cell.error
    );
    ok(
        "error names a line",
        lua.runner.line(cell, cell.error) === 1,
        String(lua.runner.line(cell, cell.error))
    );

    // 6. a function cannot be exported, and says so usefully
    id = cellWith("Desmos.f = function(x) return x end");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "function export refused with advice",
        !!cell.error && /Desmos.sample/.test(cell.error),
        cell.error
    );

    // 7. a multi-letter name is a subscript: `total` means `t_{otal}`
    id = cellWith('Desmos.total = 1\nDesmos["1x"] = 2');
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "multi-letter name becomes a subscript",
        exported("total") === "t_{otal}=1",
        exported("total") + " err=" + cell.error
    );
    ok(
        "a name that cannot be a Desmos one is still refused",
        !!cell.error && /a letter and an optional subscript/.test(cell.error),
        cell.error
    );

    // 8. the sandbox: js is absent without the pragma, present with it
    id = cellWith("Desmos.z = (js == nil) and 1 or 0");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "js absent by default",
        exported("z") === "z=1",
        exported("z") + " err=" + cell.error
    );

    id = cellWith("Desmos.y = (js ~= nil) and 1 or 0", ["unsafe"]);
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "js present with --!lua unsafe",
        exported("y") === "y=1",
        exported("y") + " err=" + cell.error
    );

    id = cellWith("Desmos.x = (js == nil) and 1 or 0");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "and it does not leak to the cell next door",
        exported("x") === "x=1",
        exported("x") +
            " - js is seeded before the environment's metatable goes on, or it would " +
            "be written into the globals every cell shares"
    );

    // 9. cross-cell globals through the shared store
    const one = cellWith("shared = 7");
    const two = cellWith("Desmos.w = shared or 0");
    change();
    lua.runner.run(lua.cell(one));
    await new Promise((r) => setTimeout(r, 40));
    lua.runner.run(lua.cell(two));
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "cell 2 sees cell 1's global",
        exported("w") === "w=7",
        exported("w") + " err=" + lua.cell(two).error
    );

    // 10. the watchdog: an infinite loop must not hang node
    id = cellWith("while true do end");
    change();
    cell = lua.cell(id);
    const t0 = Date.now();
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 300));
    ok(
        "runaway loop yielded instead of hanging",
        cell.co !== null || !!cell.error,
        "co=" + cell.co + " err=" + cell.error
    );
    ok("took breaths", cell.frames > 0, "frames=" + cell.frames);
    lua.runner.stop(cell);
    console.log(
        "        (runaway ran " +
            (Date.now() - t0) +
            "ms across " +
            cell.frames +
            " frames)"
    );

    // 11. sampling
    id = cellWith('Desmos.sample("g", function(x) return x * x end, 0, 2, 3)');
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "sample wrote xs",
        exported("gx") === "g_{x}=\\left[0,1,2\\right]",
        exported("gx") + " err=" + cell.error
    );
    ok(
        "sample wrote ys",
        exported("gy") === "g_{y}=\\left[0,1,4\\right]",
        exported("gy")
    );

    // 12. print and warn reach the console, which is the only place they go now
    const said = { log: [], warn: [] };
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...a) => said.log.push(a.join(" "));
    console.warn = (...a) => said.warn.push(a.join(" "));
    id = cellWith('print("hello", 1 + 1)\nwarn("careful")');
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    console.log = realLog;
    console.warn = realWarn;
    ok(
        "print goes to console.log",
        said.log.some((line) => line === "lua: hello\t2"),
        JSON.stringify(said.log)
    );
    ok(
        "warn goes to console.warn",
        said.warn.some((line) => line === "lua: careful"),
        JSON.stringify(said.warn)
    );

    // 13. a cell runs itself when it is discovered, which at page load is all of them
    id = cellWith("Desmos.n = 1");
    change();
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a freshly discovered cell runs itself",
        exported("n") === "n=1",
        exported("n")
    );

    // 13b. except one asking for the DOM, which only ever runs on a click
    id = cellWith("Desmos.o = 1", ["unsafe"]);
    change();
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "--!lua unsafe does not run itself",
        exported("o") === undefined,
        exported("o")
    );
    lua.runner.run(lua.cell(id));
    await new Promise((r) => setTimeout(r, 60));
    ok("but does run when asked", exported("o") === "o=1", exported("o"));

    // 13c. editing a cell never runs it
    id = cellWith("Desmos.ed = 1");
    change();
    await new Promise((r) => setTimeout(r, 60));
    lua.edited(id, "Desmos.ed = 2");
    await new Promise((r) => setTimeout(r, 900));
    ok(
        "an edit does not re-run the cell",
        exported("ed") === "e_{d}=1",
        exported("ed")
    );
    lua.runner.run(lua.cell(id));
    await new Promise((r) => setTimeout(r, 60));
    ok("the run button does", exported("ed") === "e_{d}=2", exported("ed"));

    // 13b. the trigger: an expression that is just the word becomes a cell
    const trigId = String(++idc);
    list.push({ type: "expression", id: trigId, latex: "lua" });
    change();
    await new Promise((r) => setTimeout(r, 20));
    const converted = list.find((e) => e.id === trigId);
    ok(
        "typing lua converted the expression to a note",
        converted && converted.type === "text" && converted.lua === true,
        JSON.stringify(converted)
    );
    ok("and the note is a cell", !!lua.cell(trigId), "not discovered");

    // 14. reactivity: a value the cell read changes, and the cell re-runs itself
    id = cellWith("Desmos.r = a + 1");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok("read a=5 -> r=6", exported("r") === "r=6", exported("r"));
    poke("a", 50);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a changed -> cell re-ran by itself (r=51)",
        exported("r") === "r=51",
        exported("r")
    );
    poke("a", 5);
    await new Promise((r) => setTimeout(r, 60));

    // 15. a syntax error is caught without running, and names its line
    id = cellWith("local x = 1\nlocal y = = 2");
    change();
    cell = lua.cell(id);
    ok("syntax error caught on discovery", !!cell.syntax, String(cell.syntax));
    lua.edited(cell.id, "local x = 1\nlocal y == 2");
    ok("syntax error caught on edit", !!cell.syntax, String(cell.syntax));
    lua.edited(cell.id, "Desmos.h = 1");
    ok("and cleared once it parses", !cell.syntax, String(cell.syntax));
    cell.syntax = syntaxOf(cell);
    ok(
        "syntax error names line 2",
        lua.runner.line(cell, cell.syntax) === 2,
        String(cell.syntax) + " -> " + lua.runner.line(cell, cell.syntax)
    );
    lua.edited(cell.id, "Desmos.bad = 1\nlocal y = = 2");
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a cell that does not parse never runs",
        exported("bad") === undefined,
        exported("bad")
    );

    // 16. cross-cell reactivity through the shared store
    const up = cellWith("base = 10");
    const down = cellWith("Desmos.d = base or 0");
    change();
    lua.runner.run(lua.cell(up));
    await new Promise((r) => setTimeout(r, 40));
    lua.runner.run(lua.cell(down));
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "downstream cell read upstream global",
        exported("d") === "d=10",
        exported("d")
    );
    lua.edited(up, "base = 99");
    lua.runner.run(lua.cell(up));
    await new Promise((r) => setTimeout(r, 200));
    ok(
        "upstream global changed -> downstream re-ran (d=99)",
        exported("d") === "d=99",
        exported("d")
    );

    // 17. the + menu: its button dispatches new-lua, and ready() wrapped dispatch to answer it
    const before = list.length;
    Calc.controller.dispatch({ type: "new-lua" });
    await new Promise((r) => setTimeout(r, 20));
    ok(
        "new-lua added an item",
        list.length === before + 1,
        before + " -> " + list.length
    );
    const made = list[list.length - 1];
    ok(
        "and it is a cell",
        made &&
            made.type === "text" &&
            made.lua === true &&
            !!lua.cell(made.id),
        JSON.stringify(made)
    );
    ok(
        "and the menu was told to close",
        dispatched.some((a) => a.type === "close-add-expression"),
        JSON.stringify(dispatched)
    );
    ok(
        "an unrelated dispatch still gets through",
        (() => {
            const n = dispatched.length;
            Calc.controller.dispatch({ type: "something-else" });
            return dispatched.length === n + 1;
        })()
    );

    // 18. add() puts the cell after the selection, in the same folder
    selected = { id: made.id, folderId: "F1" };
    const placed = lua.add();
    await new Promise((r) => setTimeout(r, 20));
    const at = list.findIndex((i) => i.id === placed);
    ok(
        "added straight after the selected item",
        at === list.findIndex((i) => i.id === made.id) + 1,
        "index " + at
    );
    ok(
        "and inherited its folder",
        list[at].folderId === "F1",
        list[at].folderId
    );
    selected = null;

    // 19. the trigger is lenient about how MathQuill spells the word
    for (const spelling of [
        "lua",
        "\\operatorname{lua}",
        " lua ",
        "\\mathrm{lua}"
    ]) {
        const tid = String(++idc);
        list.push({ type: "expression", id: tid, latex: spelling });
        change();
        await new Promise((r) => setTimeout(r, 20));
        const got = list.find((e) => e.id === tid);
        ok(
            "trigger accepts " + JSON.stringify(spelling),
            got && got.type === "text" && got.lua === true,
            JSON.stringify(got)
        );
    }
    // Only on the whole thing - though note this says nothing about typing, where `lua` is
    // reached on the way to `luap` and converts before the p arrives. See the README.
    const nid = String(++idc);
    list.push({ type: "expression", id: nid, latex: "luap" });
    change();
    await new Promise((r) => setTimeout(r, 20));
    ok(
        "trigger ignores a latex that merely contains the word",
        list.find((e) => e.id === nid).type === "expression"
    );

    // 20. the stylesheet, because two of its rules are load-bearing and neither is visible from
    // here: Desmos' note textarea is an invisible sheet over the whole container and has to go,
    // and Monaco's own <textarea class="inputarea"> is how it takes the mouse and must not.
    const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
    const rule = (sel) => {
        const at = css.indexOf(sel);
        return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
    };
    const area = rule("[data-cde-lua] textarea.dcg-smart-textarea");
    ok(
        "Desmos' note textarea is not hidden",
        !!area && !/display:\s*none/.test(area),
        "it is the element Desmos focuses for a note's row - hidden, Escape has nowhere to " +
            "hand the keyboard and the arrows stop working"
    );
    ok(
        "but it cannot be clicked",
        /pointer-events:\s*none/.test(area),
        "at full size and clickable it swallows every click meant for the editor under it"
    );
    ok(
        "and is shrunk to a point",
        /width:\s*1px/.test(area) && /height:\s*1px/.test(area),
        "Desmos sizes it to cover the whole container"
    );
    ok(
        "and Monaco's input textarea is untouched",
        !/(^|[\s,>])textarea(?![.\w-])/.test(
            css
                .split("}")
                .filter((r) => /display\s*:\s*none/.test(r))
                .join("}")
        ),
        "a blanket `textarea` rule makes the box unclickable and untypable"
    );
    ok(
        "the cell host is inset like the note's own text",
        /paddingLeft/.test(
            fs.readFileSync(path.join(__dirname, "editor.js"), "utf8")
        ),
        "without it the box sits under the row's icon gutter"
    );

    // 21. exports are statements, not expressions: nothing lands in the graph
    id = cellWith("Desmos.m = 3");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    const map = injected();
    const entry = Object.values(map).find((v) => v.latex === "m=3");
    ok("the export is in the statement map", !!entry, JSON.stringify(map));
    ok(
        "shaped as a statement",
        entry &&
            entry.type === "statement" &&
            entry.shouldGraph === false &&
            typeof entry.id === "string",
        JSON.stringify(entry)
    );
    ok(
        "no expression item was created for it",
        !list.some((i) => i.type === "expression" && /m=3/.test(i.latex || "")),
        JSON.stringify(list.filter((i) => i.type === "expression"))
    );
    ok(
        "and no .lua folder",
        !list.some((i) => i.type === "folder" && i.title === ".lua")
    );
    ok("a re-parse was requested", reparsed > 0, "reparsed=" + reparsed);

    // 22. stopping a run withdraws what it had exported. A definition whose cell was
    // interrupted is a value from nowhere, so the gutter button dropping it is the point.
    id = cellWith("Desmos.stopme = 1\nwhile true do end");
    change();
    cell = lua.cell(id);
    await new Promise((r) => setTimeout(r, 60));
    ok("still running", lua.runner.busy(cell), "busy=" + lua.runner.busy(cell));
    ok(
        "and had exported before it got stuck",
        exported("stopme") === "s_{topme}=1",
        exported("stopme")
    );
    lua.runner.toggle(cell);
    await new Promise((r) => setTimeout(r, 40));
    ok(
        "stopping drops the part-finished exports",
        exported("stopme") === undefined,
        exported("stopme")
    );
    ok("and the run is over", !lua.runner.busy(cell), "still busy");
    lua.edited(cell.id, "Desmos.stopme = 1");
    lua.runner.toggle(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "and the same button runs it again",
        exported("stopme") === "s_{topme}=1",
        exported("stopme")
    );

    // 23. Desmos.sample marks only the point list as something to plot
    id = cellWith('Desmos.sample("w", function(x) return x end, 0, 1, 2)');
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    const sampled = Object.values(injected()).filter((v) =>
        /w_\{?[xy]\}?|w_/.test(v.latex)
    );
    ok(
        "sample plots the points and not the columns",
        sampled.length === 3 &&
            sampled.filter((v) => v.shouldGraph).length === 1,
        JSON.stringify(sampled)
    );

    // 24. the saved shape: a flagged note, source as the text verbatim
    id = cellWith("Desmos.j = 1");
    change();
    const saved = list.find((e) => e.id === id);
    ok(
        "saved as a flagged note",
        saved.type === "text" && saved.lua === true,
        JSON.stringify(saved)
    );
    ok(
        "a plain note is not a cell",
        !lua.isCell({ type: "text", id: "z", text: "hello" })
    );
    ok(
        "with the extension off it is still readable Lua",
        saved.text === "Desmos.j = 1",
        saved.text
    );
    ok("no sentinel in the source", !/^--!lua/.test(saved.text), saved.text);
    ok(
        "and the cell reads it back unchanged",
        lua.cell(id).source === "Desmos.j = 1",
        lua.cell(id).source
    );

    // 25. a pragma line is read but left in place, so line numbers do not shift
    id = cellWith("Desmos.u = 1", ["unsafe"]);
    change();
    cell = lua.cell(id);
    ok(
        "pragma read off the first line",
        cell.pragmas.has("unsafe"),
        [...cell.pragmas].join(",")
    );
    ok(
        "and left in the source",
        /^--!lua unsafe\n/.test(cell.source),
        JSON.stringify(cell.source)
    );
    lua.edited(cell.id, "--!lua unsafe\nerror('x')");
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "so an error on source line 2 is reported as line 2",
        lua.runner.line(cell, cell.error) === 2,
        cell.error + " -> " + lua.runner.line(cell, cell.error)
    );

    // 26. the cache-lag trap: getState() is a frame behind our own setExpression, so a scan
    // that trusted it would revert a cell to its pre-write text - emptying a new cell the
    // moment focus left it. scan() reads the live models, so a stale snapshot cannot win.
    id = cellWith("");
    change();
    cell = lua.cell(id);
    lua.edited(id, "Desmos.e = 1");
    lua.flush(id);
    const realGetState = Calc.getState;
    Calc.getState = () => ({
        expressions: {
            list: list.map((i) =>
                i.id === id ? Object.assign({}, i, { text: "" }) : i
            )
        }
    });
    change();
    Calc.getState = realGetState;
    ok(
        "a stale snapshot does not wipe a cell",
        lua.cell(id).source === "Desmos.e = 1",
        JSON.stringify(lua.cell(id).source)
    );

    // 27. the editor's shape, because both of its bugs were design bugs and neither is visible
    // from here. It used to be one editor moved into the focused cell, with the rest showing a
    // colorize()d <pre>. Focusing replaced the element the click had landed on, so it took
    // several clicks to get in; and leaving a cell rebuilt its box from `cell.source`, so any
    // bug near that value showed up as the text vanishing. One editor per cell has neither.
    const ed = fs.readFileSync(path.join(__dirname, "editor.js"), "utf8");
    // editor.js with its commentary removed. Every check below is about what the code does, and
    // a source-text assertion a *comment* can satisfy proves nothing: the first version of the
    // gutter check passed against a doc comment describing the markup while the markup itself was
    // hand-rolled and invisible. Block comments go, and so do whole-line `//` ones - not trailing
    // ones, which would take the "//" out of the Monaco CDN URL with them.
    const code = ed
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
    ok(
        "no cell is re-rendered from its source text",
        !/colorize/.test(code),
        "a box rebuilt on blur turns any bug near cell.source into lost text"
    );
    ok(
        "there is an editor per cell, not one that moves",
        /editors\.set\(cell\.id,/.test(code),
        "a moved editor replaces the element the click landed on"
    );
    ok(
        "and no static stand-in for it",
        !/cde-lua__static/.test(
            ed + fs.readFileSync(path.join(__dirname, "index.css"), "utf8")
        ),
        "the static form is what went blank"
    );

    // 28. the keys, as far as they can be checked without a DOM: Escape hands the row back
    // through Desmos' own focus dispatches, and Shift+Enter adds a line at the selection.
    ok(
        "Escape hands the row to Desmos rather than only dropping focus",
        /move-focus-to-item/.test(code) && /set-selected-id/.test(code),
        "Desmos keeps focus as state; blurring alone leaves no row focused"
    );
    ok(
        "Shift+Enter is bound",
        /KeyMod\.Shift \| api\.KeyCode\.Enter/.test(code),
        "plain Enter must stay a newline, so the row shortcut needs its own binding"
    );
    ok(
        "and adds an expression below, focused",
        /type: "new-expression"/.test(code),
        "new-expression inserts at the selection with shouldFocus"
    );

    ok(
        "focusing a cell moves Desmos' selection marker to its row",
        /onDidFocusEditorText/.test(code) && /set-selected-id/.test(code),
        "the editor is ours, so Desmos has no other way of knowing which row is in use"
    );
    ok(
        "Escape hands the keyboard to the note's own textarea",
        /querySelector\("textarea\.dcg-smart-textarea"\)/.test(code),
        "the row container's keydown only handles reorder mode, so focusing it leaves the " +
            "arrows dead"
    );

    ok(
        "Tab from the row puts the caret at the end of the code",
        /event\.key === "Tab"/.test(code) && /getLineMaxColumn/.test(code),
        "the same move Tab makes over an expression"
    );
    ok(
        "and keys from inside the editor are left to it",
        /host\.contains\(event\.target\)/.test(code),
        "otherwise Tab could never indent"
    );
    ok(
        "a letter typed on the row goes into the code and is typed there",
        /event\.key\.length === 1/.test(code) &&
            /trigger\("cde-lua", "type"/.test(code),
        "the keystroke is cancelled, so the character has to be put in by hand"
    );
    ok(
        "and the row's own textarea cannot take text",
        /area\.readOnly = true/.test(code),
        "it still holds the source, so a stray keystroke would be spliced into it"
    );
    ok(
        "the keyboard survives Monaco replacing the fallback textarea",
        /cell\.box\.contains\(document\.activeElement\)/.test(code),
        "the first cell is made before Monaco has loaded, and would lose its caret"
    );

    // 29. a plain global write is an export, and so is _G
    id = cellWith("pp = 2\n_G.qq = 3");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a plain global write exports",
        exported("pp") === "p_{p}=2",
        exported("pp") + " err=" + cell.error
    );
    ok(
        "and so does one through _G",
        exported("qq") === "q_{q}=3",
        exported("qq")
    );

    // 30. a value with no Desmos spelling is stored and not exported. This is what keeps a
    // cross-cell function working: `function f() end` is a global write like any other, and
    // erroring on it would be erroring on the whole point of sharing globals.
    const holder = cellWith("function helper1() return 11 end\nlabel = 'hi'");
    const caller = cellWith("Desmos.hh = helper1()");
    change();
    lua.runner.run(lua.cell(holder));
    await new Promise((r) => setTimeout(r, 40));
    lua.runner.run(lua.cell(caller));
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a function is stored, not exported",
        exported("helper1") === undefined,
        exported("helper1")
    );
    ok("nor is a string", exported("label") === undefined, exported("label"));
    ok(
        "and the holder did not error over either",
        !lua.cell(holder).error,
        lua.cell(holder).error
    );
    ok(
        "another cell can call it",
        exported("hh") === "h_{h}=11",
        exported("hh") + " err=" + lua.cell(caller).error
    );
    ok(
        "Desmos.k = <a string> still refuses out loud",
        (() => {
            const strict = cellWith('Desmos.k = "hi"');
            change();
            lua.runner.run(lua.cell(strict));
            return true;
        })()
    );
    await new Promise((r) => setTimeout(r, 60));

    // 31. a function the graph defines is callable, and a list argument is one call
    const calls = helpers.length;
    id = cellWith("Desmos.ff = f(3)\nDesmos.fl = f({1, 2, 3})");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 120));
    ok(
        "a Desmos function is callable from Lua (f(3) = 9)",
        exported("ff") === "f_{f}=9",
        exported("ff") + " err=" + cell.error
    );
    ok(
        "and takes a list, coming back a list",
        exported("fl") === "f_{l}=\\left[1,4,9\\right]",
        exported("fl")
    );
    ok(
        "three values cost one trip to the evaluator, not three",
        helpers.length - calls === 2,
        "made " + (helpers.length - calls) + " helpers"
    );

    // 32. a name nothing defines is nil, and costs nothing. NaN would be a number, and so
    // truthy, which would quietly break `if not cache then cache = {} end`.
    const cold = helpers.length;
    id = cellWith("Desmos.un = (nothingdefined == nil) and 1 or 0");
    change();
    cell = lua.cell(id);
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "an undefined name reads nil",
        exported("un") === "u_{n}=1",
        exported("un") + " err=" + cell.error
    );
    ok(
        "and asks the evaluator nothing",
        helpers.length === cold,
        "made " + (helpers.length - cold) + " helpers"
    );

    // 33. a cell that writes a name it also reads must not invalidate itself. Now that a plain
    // write is an export, that is an ordinary thing to write rather than a curiosity.
    //
    // It takes three runs to reach the shape that loops, which is why this is not one. Run 1
    // finds nothing in the globals, so it reads the *graph* for `spin` and only writes the
    // globals; run 2 reads the globals but files that read at the end, after its own write has
    // already gone by; run 3 is the first whose write meets a filed read of the same name. From
    // there, unguarded, it re-runs itself until the loop guard calls it.
    id = cellWith("spin = (spin or 0) + 1\nDesmos.sp = spin");
    change();
    cell = lua.cell(id);
    await new Promise((r) => setTimeout(r, 80));
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 60));
    lua.runner.run(cell);
    await new Promise((r) => setTimeout(r, 250));
    ok(
        "a cell does not re-run itself over its own write",
        exported("sp") === "s_{p}=3" && !cell.error,
        exported("sp") + " err=" + cell.error
    );

    // 34. the gutter button, which needs a DOM to press but not to look at
    ok(
        "the run button carries tapboundary",
        /tapboundary/.test(code),
        "Desmos' tap dispatcher walks outwards to the first element containing the pointer and " +
            "stops at one of these; without it the tap lands on the drag handle"
    );
    ok(
        "and wears Desmos' own play and pause glyphs",
        /dcg-icon-play/.test(code) && /dcg-icon-pause/.test(code),
        "a slider's button is the thing it is meant to look like"
    );
    // The first attempt drew this button itself - a bare glyph at a guessed size in a guessed
    // colour, with no ring - and it came out invisible against the sheet. The whole chain is
    // Desmos' now, so the circle, the 29px and the theme's outline colour are the real ones.
    ok(
        "and is placed and circled by Desmos' own icon chain",
        /dcg-expression-icon-container/.test(code) &&
            /dcg-circular-icon-container/.test(code) &&
            /dcg-circular-icon dcg-thick-outline/.test(code),
        "hand-rolling the ring, the size and the colour is what made it invisible"
    );
    ok(
        "with no geometry of our own left over",
        !/margin: -\d+px|font-size: 1\d0%/.test(
            css.slice(css.indexOf(".cde-lua__icon"))
        ),
        "two sets of numbers for one button is how they drift apart"
    );
    // A selected row fills its tab with the accent colour, so an icon that stays dark vanishes
    // into it. Desmos' icons take a `whiteIcon` prop from renderItemSelected(id), which is the
    // same predicate that puts `dcg-selected` on the row - so the row's class is the hook, and
    // nothing has to watch the selection to keep up with it.
    ok(
        "and turns white on a selected row, as Desmos' own icons do",
        /\[data-cde-lua\]\.dcg-selected[\s\S]{0,200}color: #fff/.test(css),
        "a selected row's tab is filled with the accent colour and a dark icon disappears in it"
    );
    ok(
        "an error shows as Desmos shows one",
        /dcg-tooltipped-error/.test(code) && /dcg-icon-error/.test(code),
        "an expression's error in Desmos is its gutter icon, in that exact markup"
    );
    ok(
        "and the note's own icon is out of its way",
        /\[data-cde-lua\] \.dcg-tab \.dcg-icon-text/.test(css),
        "both would otherwise sit in the same absolutely-positioned spot"
    );
    ok(
        "nothing is left of the bar or the output strip",
        !/cde-lua__run|cde-lua__status|cde-lua__out|cde-lua__error/.test(
            ed + css
        ),
        "the button moved to the gutter and print goes to the console"
    );

    console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
    process.exit(fails ? 1 : 0);
}
main().catch((e) => {
    console.error("harness blew up:", e && e.message ? e.message : e);
    console.error(
        (e && e.stack ? e.stack : "").split("\n").slice(1, 8).join("\n")
    );
    process.exit(2);
});
