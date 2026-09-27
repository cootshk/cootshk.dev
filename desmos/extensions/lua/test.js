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
let selected = null;
const dispatched = [];
let reparsed = 0;
// What Calc.observeEvent("change.cdeLua") would fire. Rescanning is how index.js notices a
// note that has appeared, so the harness has to do it the same way the graph would.
const change = () => observers.forEach((cb) => cb());
let list = [];
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

    // 4. the reaper is Desmos' own diff: an export that stops being made is simply absent
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
        converted && converted.type === "text" && converted.lua === true,
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
    const hides = css
        .split("}")
        .filter((rule) => /display\s*:\s*none/.test(rule))
        .join("}");
    ok(
        "hides Desmos' invisible note textarea",
        /textarea\.dcg-smart-textarea/.test(hides),
        "it would swallow every click"
    );
    ok(
        "does not hide Monaco's input textarea",
        !/(^|[\s,>])textarea(?![.\w-])/.test(hides),
        "a blanket `textarea` here makes the box unclickable and untypable"
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
    lua.runner.setOn(cell, true);
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
    ok(
        "a re-parse was requested",
        dispatched.length >= 0 && reparsed > 0,
        "reparsed=" + reparsed
    );

    // 22. switching a cell off withdraws its definitions
    lua.runner.setOn(cell, false);
    await new Promise((r) => setTimeout(r, 20));
    ok("off withdraws the export", exported("m") === undefined, exported("m"));

    // 23. Desmos.sample marks only the point list as something to plot
    id = cellWith('Desmos.sample("w", function(x) return x end, 0, 1, 2)');
    change();
    cell = lua.cell(id);
    lua.runner.setOn(cell, true);
    await new Promise((r) => setTimeout(r, 60));
    const sampled = Object.values(injected()).filter((v) =>
        /w_\{[xy]\}|w_/.test(v.latex)
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
        "and with the extension off it is still readable Lua",
        saved.text === "Desmos.j = 1",
        saved.text
    );
    ok(
        "the source is the text, verbatim",
        saved.text === "Desmos.j = 1",
        JSON.stringify(saved.text)
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
    lua.runner.setOn(cell, true);
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
    // A snapshot that has not caught up yet, exactly as Desmos would serve it.
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
    ok(
        !/colorize/.test(ed),
        "no cell is re-rendered from its source text",
        "a box rebuilt on blur turns any bug near cell.source into lost text"
    );
    ok(
        /editors\.set\(cell\.id,/.test(ed),
        "there is an editor per cell, not one that moves",
        "a moved editor replaces the element the click landed on"
    );
    ok(
        !/cde-lua__static/.test(
            ed + fs.readFileSync(path.join(__dirname, "index.css"), "utf8")
        ),
        "and no static stand-in for it",
        "the static form is what went blank"
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
