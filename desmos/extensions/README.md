# Extensions

Each extension is a folder in here named after its id:

```
extensions/
  matrices/
    index.js      the hooks
    index.css     optional; injected before they run
```

A bigger one can be several scripts - see *Splitting one across several files*.

## Adding an extension
- make `<id>/index.js` and hand an object to `extension()`
- add it to `../extensions.json` - nothing is loaded that isn't declared there
- give it an `index.css` and set `"css": true` if it draws anything

`"file"` overrides the script's name and `"css"` can name a stylesheet other than
`index.css`; both are resolved inside the extension's own folder.

## Splitting one across several files
`"file"` also takes a list, for an extension that has outgrown a single script:

```json
"settings": {
    "file": ["index.js", "tabs/extensions.js", "tabs/themes.js"]
}
```

They run in the order they are named, so a later file may reach for whatever an
earlier one registered - `extensions/settings` is the worked example: `index.js`
calls `extension()` and the files in `tabs/` hand themselves to the
`Extensions.settings.tab()` that leaves behind. One `extension()` call between
them all: the list is one extension in several files, not several extensions.

That ordering is the only thing a later file may lean on. Everything else is the
usual race - another extension is only certainly registered once a hook is
running, never at the top level.

## Patching the Desmos bundle
Put a `patches` list in the object you hand to `extension()`. Each patch is
`{ match, replace }`, applied to the bundle in order:

```js
extension({
  id: "matrices",
  patches: [
    { match: /\i\.includes\(\i\)\|\|(?=\i\.restrictedFunctions)/g, replace: "", count: 1 },
  ],
});
```

- `\i` expands to one JavaScript identifier, `(?:[A-Za-z_$][\w$]*)`. Desmos' minified
  names change with every build, so never write them out.
- `replace` is a `String.replace` replacement: `$1`, `$2`, `$<name>` and `$&` put the
  captured pieces back. A function works too. A `/g` match replaces every occurrence, a
  plain one only the first.
- A patch that matches nothing throws, and the extension is dropped for that load - it
  will not silently half-apply itself to a build that moved on.
- `count` asserts how many times the pattern appears. `count: 1` is the usual "this had
  better be the only place" check.

`source(js, ctx)` is still there for anything this can't express, and runs after the
patches.

Writing one of these against a minified build is easier with the **Patch Helper**: turn
that extension on and a tab of its own appears next to Examples, with a match and a replace
box over a diff of what the patch would do to the bundle. It compiles the pattern with the
loader's own `canonicalizeMatch`, so `\i` and the implied `/g` behave exactly as they will
in a real patch, and it shows every match with the bundle either side of it - which is how
a pattern that is looser than it looks gives itself away. Turn *Regex* off and the box is
the literal string a `match` written as one would be, replaced only where it first appears
and counted everywhere it occurs, just as `count` counts it.

## Drawing UI
Desmos owns the whole document, so an extension that wants to show something
builds it out of what Desmos put there - stylesheet included. An `index.css`
declared with `"css": true` is fetched with the script and injected before any of
the extension's code runs, so whatever it draws is styled the moment it appears.
Write it against Desmos' own theme variables (`--dcg-custom-text-color`,
`--dcg-custom-background-color`, `--dcg-custom-border-color`, `--dcg-accent-color`
and friends, all with fallbacks) and it will follow the calculator rather than
stand apart from it. `extensions/settings/index.css` is the worked example.

A stylesheet cannot be `<link>`ed: the proxy rewrites every href it is handed, so
the text is fetched through `local.fetch` and injected. That is also why a missing
one is only logged - the extension still runs, just unstyled.

The rest of the toolkit is on `window.__desmosExt.ui` (see `../ui.js`), which
every hook that runs after the swap can reach.

The easy way in is a `ui` hook, which gets a container on the extension's own
card in the Extensions tab (the saved-graphs modal, next to "Examples"):

```js
extension({
  id: "matrices",
  ui(root, data) {
    const ui = window.__desmosExt.ui;
    ui.el(root, null, ui.el("label", {}, ui.el("input", { type: "checkbox" }), " Auto-transpose"));
  },
});
```

`ui` runs in this window like every other hook, so it is ordinary code - close
over whatever you like; `data` is whatever `setup()` returned. Only a running
extension has a panel - there is nothing to configure about one that is switched
off.

For anything that isn't a settings panel, patch Desmos to call
`window.__desmosExt.ui.mount("<name>", el)` wherever you want the UI, and fill
that slot from `main()`:

```js
window.__desmosExt.ui.slot("my-panel", (root) => {
  root.textContent = "hello";
  return () => {}; // optional teardown, run when Desmos unmounts the element
});
```

The rest of `ui` - `el`, `css` (for styling that has to be computed), the
extension list, the toggles, `dirty`/`reload` - is documented at the top of
`../ui.js`.

## Fetching your own files
Desmos runs in this document, which means the proxy's bootstrap has patched
`fetch` and the `src`/`href` setters by the time `main()` and `ready()` run:
anything root-relative it is handed picks up the `/_/desmos` prefix and goes to
desmos.com. For a file of this site's own, use `ctx.fetch` (in `setup`) or
`window.__desmosExt.fetch` (after the swap). See `../local.js`.

Requests that *should* be rewritten - a third-party host that needs the proxy for
CORS, say - want the ordinary `fetch`; `extensions/oneko` and
`extensions/desmodder` both rely on that.

## Manifest flags
`forceEnabled: true` pins an extension on: its toggle is locked, and `?ext=`
cannot leave it out. It is for extensions that the UI itself depends on.
