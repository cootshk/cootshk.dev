// Do this extension's bundle patches still match?
//
//     node desmos/extensions/lua/patches.test.js
//
// A patch that matches nothing throws and drops the whole extension for that load
// (extensions.js:200-206), which for this one means a graph's cells show as raw notes. Desmos
// ships a new build regularly, so "it worked when it was written" is not an answer. This
// fetches the live bundle, applies the patches with the loader's own canonicalizeMatch, and
// checks each lands the number of times it says it will - then that the result still parses.
//
// Needs the network. The Patch Helper tab is the interactive version of the same thing, and the
// place to go once this says something has moved.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../../..");
const PAGE = "https://www.desmos.com/calculator";
const CACHE = path.join(os.tmpdir(), "cde-lua-bundle");

function fetchText(url) {
    return execFileSync(
        "curl",
        ["-sL", "--max-time", "180", "-A", "Mozilla/5.0", url],
        {
            maxBuffer: 64 * 1024 * 1024,
            encoding: "utf8"
        }
    );
}

/** The bundle, cached by its own hashed filename so a re-run is instant. */
function bundle() {
    const page = fetchText(PAGE);
    const src = /src="(\/assets\/build\/[^"]*calculator[^"]*\.js)"/.exec(page);
    if (!src) throw new Error("couldn't find the bundle's URL on " + PAGE);

    const file = path.join(CACHE, path.basename(src[1]));
    if (fs.existsSync(file))
        return { js: fs.readFileSync(file, "utf8"), url: src[1] };

    const js = fetchText("https://www.desmos.com" + src[1]);
    if (js.length < 1000000)
        throw new Error("that bundle looks too small: " + js.length);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, js);
    return { js, url: src[1] };
}

/** canonicalizeMatch and countMatches, out of the loader rather than reimplemented. */
function engine() {
    const src = fs.readFileSync(
        path.join(ROOT, "desmos/extensions.js"),
        "utf8"
    );
    return new Function(
        "window",
        "document",
        "location",
        "fetch",
        "console",
        src + "\n;return { canonicalizeMatch, countMatches, expandSelf };"
    )(
        { Extensions: {} },
        { querySelector: () => null },
        { search: "" },
        () => {},
        console
    );
}

/** The patch list, read off the extension itself. */
function patches() {
    let def = null;
    const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
    new Function(
        "window",
        "document",
        "extension",
        "MutationObserver",
        "console",
        src
    )(
        { Extensions: {}, addEventListener: () => {}, fengari: {} },
        {
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {}
        },
        (d) => {
            def = d;
        },
        class {
            observe() {}
        },
        console
    );
    return (def && def.patches) || [];
}

let fails = 0;
function ok(cond, name, extra) {
    console.log(
        (cond ? "  PASS  " : "  FAIL  ") +
            name +
            (cond ? "" : "\n        " + extra)
    );
    if (!cond) fails++;
}

let got;
try {
    got = bundle();
} catch (error) {
    console.log("  SKIP  couldn't fetch the bundle: " + error.message);
    process.exit(0);
}

const { canonicalizeMatch, countMatches, expandSelf } = engine();
let js = got.js;
console.log(got.url + "  (" + js.length + " bytes)\n");

patches().forEach((patch, n) => {
    const label = "#" + (n + 1) + " " + String(patch.match).slice(0, 64);
    const match = canonicalizeMatch(patch.match, patch.count);
    const found = countMatches(js, match);

    if (patch.count === undefined ? found === 0 : found !== patch.count) {
        ok(
            false,
            label,
            "expected " + patch.count + " match(es), found " + found
        );
        return;
    }
    const before = js;
    js = js.replace(match, expandSelf(patch.replace, "lua"));
    ok(
        js !== before,
        label + "   (" + found + ")",
        "matched but replaced nothing"
    );
});

// The patches are only right if what comes out is still JavaScript.
const out = path.join(CACHE, "patched.js");
fs.writeFileSync(out, js);
try {
    execFileSync(process.execPath, ["--check", out], { stdio: "pipe" });
    ok(true, "the patched bundle still parses");
} catch (error) {
    ok(
        false,
        "the patched bundle still parses",
        String(error.stderr).slice(0, 300)
    );
}

// And only useful if the menu really ends up offering it.
ok(
    /push\("lua"\)/.test(js),
    'getAddExpressionItems offers "lua"',
    "the + menu would not list it"
);
ok(
    /case"lua":case"expression"/.test(js),
    'the menu routes "lua" to Desmos\' item button',
    "the entry would render nothing"
);

// The flag has to persist, which is the whole point of both patches.
ok(
    /cachedViewState=\{type:\w+\.type,id:\w+\.id,folderId:\w+\.folderId,text:\w+\.text,lua:/.test(
        js
    ),
    "the flag is in a note's saved state",
    "a cell would come back from getState() as a plain note"
);
ok(
    /\{id:!1,type:!1,folderId:!0,text:!0,secret:!0,readonly:!0,lua:!0\}/.test(
        js
    ),
    "and in its undo restoration props",
    "undo would drop the flag"
);

// And the applier hook, which is what makes a Lua function an action at all.
ok(
    /if\(\w+\.eventUpdates\)\{window\.Extensions\["lua"\]\.actionUpdates\(\w+\.eventUpdates\.updates\);for\(let /.test(
        js
    ),
    "a Lua body gets to run inside an action's fire",
    "without this a Lua function cannot be an action"
);

console.log(
    "\n" +
        (js.match(/case"lua":/g) || []).length +
        ' case"lua": arms in the patched bundle'
);

console.log(fails ? "\n" + fails + " FAILED" : "\nall patches good");
process.exit(fails ? 1 : 0);
