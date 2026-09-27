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
const GRAPH = { a: 5, b: 3, L: [1, 2, 3] };
const observers = [];
// What Calc.observeEvent("change.cdeLua") would fire. Rescanning is how index.js notices a
// note that has appeared, so the harness has to do it the same way the graph would.
const change = () => observers.forEach((cb) => cb());
let list = [];
const helpers = [];

const Calc = {
    getState: () => ({ expressions: { list: list.slice() } }),
    setExpression(spec) {
        const at = list.findIndex((i) => i.id === spec.id);
        if (at === -1) list.push(Object.assign({}, spec));
        else list[at] = Object.assign({}, list[at], spec);
    },
    removeExpression({ id }) {
        list = list.filter((i) => i.id !== id);
    },
    observeEvent: (name, cb) => {
        observers.push(cb);
    },
    unobserveEvent: () => {},
    controller: { generateId: () => String(++idc) },
    HelperExpression({ latex }) {
        const h = { numericValue: NaN, listValue: undefined, _cbs: [] };
        h.observe = (_k, cb) => h._cbs.push(cb);
        helpers.push({ latex, h });
        setTimeout(() => {
            const plain = latex.replace(/_\{(\w+)\}/g, "_$1");
            const v = GRAPH[plain];
            if (Array.isArray(v)) h.listValue = v;
            else h.numericValue = v === undefined ? NaN : v;
            h._cbs.forEach((cb) => cb());
        }, 10);
        return h;
    }
};

/** Change a graph value and tell whatever is watching it, the way the evaluator would. */
function poke(name, value) {
    GRAPH[name] = value;
    helpers
        .filter((e) => e.latex.replace(/_\{(\w+)\}/g, "_$1") === name)
        .forEach((e) => {
            if (Array.isArray(value)) e.h.listValue = value;
            else e.h.numericValue = value;
            e.h._cbs.forEach((cb) => cb());
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
function exported(name) {
    const e = list.find(
        (i) =>
            i.id && i.id.indexOf("-" + name) === i.id.length - name.length - 1
    );
    return e && e.latex;
}

/** Put the line-2 syntax error back, to check line() reads it. */
function syntaxOf(cell) {
    const save = cell.source;
    cell.source = "local x = 1\nlocal y = = 2";
    const bad = lua.runner.check(cell);
    cell.source = save;
    return bad;
}

function cellWith(source, pragmas) {
    const id = String(++idc);
    list.push({ type: "text", id, text: lua.compose(pragmas || [], source) });
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
    lua.runner.setOn(cell, true);
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
    lua.runner.setOn(cell, true);
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
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 80));
    ok(
        "list read (1+2+3 = 6)",
        exported("s") === "s=6",
        exported("s") + " err=" + cell.error
    );

    // 4. the reaper
    lua.edited(cell.id, "Desmos.s = 1");
    await new Promise((r) => setTimeout(r, 900));
    ok("reaped nothing to reap", exported("s") === "s=1", exported("s"));
    lua.edited(cell.id, "-- nothing");
    await new Promise((r) => setTimeout(r, 900));
    ok(
        "export reaped when it stops being made",
        exported("s") === undefined,
        exported("s")
    );

    // 5. errors
    id = cellWith("Desmos.q = nope()");
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
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
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "function export refused with advice",
        !!cell.error && /Desmos.sample/.test(cell.error),
        cell.error
    );

    // 7. multi-letter name refused
    id = cellWith("Desmos.total = 1");
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "multi-letter name refused",
        !!cell.error && /one letter/.test(cell.error),
        cell.error
    );

    // 8. the sandbox: js is absent without the pragma, present with it
    id = cellWith("Desmos.z = (js == nil) and 1 or 0");
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "js absent by default",
        exported("z") === "z=1",
        exported("z") + " err=" + cell.error
    );

    id = cellWith("Desmos.y = (js ~= nil) and 1 or 0", ["unsafe"]);
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "js present with --!lua unsafe",
        exported("y") === "y=1",
        exported("y") + " err=" + cell.error
    );

    // 9. cross-cell globals through the shared store
    const one = cellWith("shared = 7");
    const two = cellWith("Desmos.w = shared or 0");
    change();
    lua.runner.setOn(lua.cell(one), true);
    await new Promise((r) => setTimeout(r, 40));
    lua.runner.setOn(lua.cell(two), true);
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
    lua.runner.setOn(cell, true);
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
    lua.runner.setOn(cell, true);
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

    // 12. print reaches the cell's output
    id = cellWith('print("hello", 1 + 1)');
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "print captured",
        cell.output.join("") === "hello\t2",
        JSON.stringify(cell.output)
    );

    // 13. off by default
    id = cellWith("Desmos.n = 1");
    change();
    ok("a freshly discovered cell is off", lua.cell(id).on === false);
    await new Promise((r) => setTimeout(r, 40));
    ok("and it has not run", exported("n") === undefined, exported("n"));

    // 13b. the trigger: an expression that is just the word becomes a cell
    const trigId = String(++idc);
    list.push({ type: "expression", id: trigId, latex: "lua" });
    change();
    await new Promise((r) => setTimeout(r, 20));
    const converted = list.find((e) => e.id === trigId);
    ok(
        "typing lua converted the expression to a note",
        converted && converted.type === "text",
        JSON.stringify(converted)
    );
    ok("and the note is a cell", !!lua.cell(trigId), "not discovered");
    ok("which starts off", lua.cell(trigId) && lua.cell(trigId).on === false);

    // 14. reactivity: a value the cell read changes, and the cell re-runs itself
    id = cellWith("Desmos.r = a + 1");
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
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
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "a cell that does not parse never runs",
        exported("q") === undefined,
        exported("q")
    );

    // 16. cross-cell reactivity through the shared store
    const up = cellWith("base = 10");
    const down = cellWith("Desmos.d = base or 0");
    change();
    lua.runner.setOn(lua.cell(up), true);
    await new Promise((r) => setTimeout(r, 40));
    lua.runner.setOn(lua.cell(down), true);
    await new Promise((r) => setTimeout(r, 60));
    ok(
        "downstream cell read upstream global",
        exported("d") === "d=10",
        exported("d")
    );
    lua.edited(up, "base = 99");
    await new Promise((r) => setTimeout(r, 1000));
    ok(
        "upstream global changed -> downstream re-ran (d=99)",
        exported("d") === "d=99",
        exported("d")
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
