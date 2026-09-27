# Lua

Lua cells in the expression sheet. Pick **lua** from the `+` menu - next to note and table - or
type `lua` into an empty expression, and the row becomes an editor; a cell can read the graph's
values as ordinary globals and hand values back by assigning to `Desmos`.

Nothing runs until you press the ▶ on the cell, and **every cell is off on every page load**.
A graph you have just opened is somebody else's code.

## A cell

A cell is a note whose text begins `--!lua`, which is why it survives saving, undo, version
history, `.dcg` files and desmos.com without this extension having to teach Desmos a new item
type - and why, with the extension off, you still see your Lua rather than losing it. `--!lua`
is a Lua comment, so the note's text _is_ the chunk: nothing is reassembled and nothing is
escaped.

```lua
--!lua
Desmos.k = a * 2
```

Words after `--!lua` are pragmas. There is one: `unsafe`.

Desmos has no typed-word conversions of its own - `table` is not one either, whatever the
folklore says - so the `lua` trigger is this extension's. It fires the moment an expression's
latex is exactly `lua`, which means you cannot type `lua` as a product of three variables, and
cannot type a longer name that passes through it on the way: `lua` converts before the `p` of
`luap` arrives. Undo gives the expression back.

The `+` menu is the route that does not depend on any of that, and
`Extensions.lua.add()` from the console is a third.

## A real item type

A cell would read better as its own item type - `{type:"lua", source:"..."}` - and this is what
that would take, written down because finding it was the expensive part.

**desmos.com is not the obstacle.** The server stores `state` as an opaque JSON string and does
no schema validation: a graph containing a `type:"lua"` item posted to the endpoint behind
`createSnapshotLink()` came back from its `stateUrl` byte for byte, `source` intact. That was
the gate this extension was built against, and it was the wrong gate.

The client is the obstacle. `setState` branches, and the branches fail differently:

```js
t?.useIncrementalUpdate
    ? gU(this.listModel, pre(this.listModel, e.expressions))
    : dre(this.listModel, e.expressions, t || {});
```

| site             | what it does with a type it does not know                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Hv(r, e)`       | state -> item model. `default: return e` - hands back the raw state object, which is then pushed into `__itemModelArray` and `__itemIdToModel`. Not dropped; a foreign object where a model belongs. |
| `pre(r, e)`      | the `useIncrementalUpdate` path. ``default: throw new Error(`Unknown item type: ${JSON.stringify(n)}`)`` - it **throws**.                                                                            |
| the row renderer | the item-type switch. The `+` menu patch in `index.js` already sits on its sibling (`case"expression":case"note":case"table":case"folder":`).                                                        |
| the serializer   | the other direction, for `getState`.                                                                                                                                                                 |

Three `"Unknown item type"` guards exist in the state-to-item path in total.

Note `allowUndo` and `useIncrementalUpdate` are independent options - only the second selects
the throwing path. So this repo's own saves (`settings/tabs/savedGraphs.js:222`, and `convert`,
`add` and `tidy` here) take the shrugging `dre` path, while **version-history restore** and
calc-instance sync pass `useIncrementalUpdate:true` and would throw.

That is five or so patches on top of the six here, each of which drops the whole extension when
it misses - and the failure mode is a graph whose cells render as nothing. Build it behind the
note form, not instead of it, so a missed patch degrades rather than loses someone's code.

## Reading the graph

Any Desmos name is a global. `a` is `a`, and `a_b` is `a_{b}` - one letter and an optional
subscript, which is what a Desmos name is.

```lua
Desmos.c = a * 2 + b        -- numbers
local total = 0
for _, x in ipairs(L) do    -- a list-valued name arrives as a table
    total = total + x
end
```

A value the evaluator has not produced yet does not come back as `nil`: the cell **stops and
waits**, then carries on when the value lands. So a cell can read a name defined below it, or
on a graph that has only just opened, and still be correct.

Whatever a cell reads becomes what it watches. Change `a` and every cell that read `a` runs
again by itself. That includes globals from other cells - one cell's `base = 10` is another
cell's `base`, and changing it re-runs the reader.

`Desmos.get(latex)` is the way to read anything that is not a plain name:

```lua
Desmos.get("\\sin(2)")
Desmos.get("\\left(P\\right).x")   -- a point's components; see Limits
```

## Writing to the graph

Assign to `Desmos`. Each assignment becomes a **statement in Desmos' evaluator** - not an
expression in the list. Desmos resolves it exactly as it would a definition you had typed, but
there is no item on the sheet, nothing in the saved graph, and nothing on the undo stack.

How: `requestParseForAllItems()` builds a map of everything on the graph with latex in it, then
diffs that map against the previous one and calls the evaluator's `addStatement` /
`removeStatement` for whatever changed. One patch injects the cells' exports into that map at
the last moment before the diff (`index.js`). The reaper comes free with it - an export a cell
no longer makes is simply absent from the map, so Desmos removes the statement itself.

```lua
Desmos.k = 42                      -- k=42
Desmos.v = {1, 2, 3}               -- v=\left[1,2,3\right]
Desmos.p = {x = 1, y = 2}          -- p=\left(1,2\right)
Desmos.q = {{x=0,y=0}, {x=1,y=1}}  -- a list of points
Desmos.k = nil                     -- and it is gone
```

A plain global is **not** an export. `helper = function() end` at the top of a cell is a global
write, and a graph full of expressions named `helper` would help nobody. Globals are how cells
talk to each other; `Desmos` is how a cell talks to the graph.

Names are one letter and an optional subscript, because that is what Desmos will parse.
`Desmos.total` is refused, with the reason.

### Functions

**A Lua function cannot become a Desmos function.** Values are one thing - a statement's latex
is just text, so a number or a list travels fine - but a _call_ is another: Desmos evaluates in
a worker, and wants derivatives, interval arithmetic and list broadcasting from anything it
calls. A closure gives it none of those, and it is on the wrong thread besides. Two things work
instead.

Write the latex yourself - Lua is very good at this, and it is the reason to reach for a cell
in the first place:

```lua
local terms = {}
for n = 1, 12 do
    terms[#terms + 1] = "\\frac{x^{" .. (2 * n - 1) .. "}}{" .. fact(2 * n - 1) .. "}"
end
Desmos.define("S(x)", table.concat(terms, "-"))
```

Or sample it, which plots:

```lua
Desmos.sample("g", function(x) return math.sin(x) ^ 3 end, -10, 10, 500)
```

`sample` defines `g_{x}`, `g_{y}` and a point list `g` - the last of which is the one marked to
be plotted. It is N points with straight lines between them: no derivative, wrong across a
discontinuity, and nothing outside the range you gave. That is the honest shape of a Lua
function on a Desmos graph.

## `print`

Goes to a strip under the cell, and to the console.

## What a cell can reach

A cell starts with `math`, `string`, `table`, `coroutine`, `utf8`, `pairs`/`ipairs`, `pcall`,
`select`, `tonumber`, `tostring`, `type`, `assert`, `error`, `print` and `Desmos`. `_G` is a
table the cells share, not the page's globals.

Left out: `debug` (it reaches upvalues and the registry, so it escapes any of this), `load`,
`require`, `dofile` (they build an environment of their own), `io`, `os` and `package`.

`js` - the whole DOM, through fengari's interop - is behind a pragma:

```lua
--!lua unsafe
js.global.console:log("hello")
```

That is real: `js.global` is this page, same-origin, with its storage and its session. A cell
with `unsafe` on it can do anything a script on cootshk.dev can do. It still will not run until
you press ▶, which is the control that matters.

## Loops

A cell that never finishes does not take the tab with it - it yields every few million
instructions and picks up on the next frame, and gives up after ten seconds. A cell that
re-runs more than twenty times while the graph settles is called a dependency loop and stopped;
that is easy to build by exporting a value the same cell reads.

What this does not catch is a single expensive call - `string.rep("x", 1e9)` is one Lua
instruction and will still hurt.

## Limits

- Numbers and lists of numbers can be read. A point reads as `NaN`; use
  `Desmos.get("\\left(P\\right).x")`.
- An undefined name and `NaN` look the same, because to the evaluator they are.
- A cell that reads a value from somewhere it cannot pause - a `js` callback, `table.sort`'s
  comparator - takes `nil` that once and is re-run from the top when the value arrives.
- An export is invisible: there is no row to click, so a wrong value has to be debugged from the
  cell that made it. Switching a cell off withdraws everything it defined.
- Cells _start_ in sheet order. They do not finish in it, because any of them may pause on a
  read. "A later cell sees an earlier cell" is the rule that holds.
- Monaco comes from jsDelivr. Without it a cell is a plain textarea - editing, saving and
  running all still work; the colours and the error squiggles do not.

## Tests

```
node desmos/extensions/lua/test.js            # the Lua half, offline
node desmos/extensions/lua/patches.test.js    # do the + menu patches still match?
```

`test.js` runs index.js, bridge.js and runner.js against the real VM out of
`cdn/fengari-web.js` and a stub `Calc` that reports values on a timer - so the pause-and-resume
path is exercised rather than assumed. No browser, nothing to install.

`patches.test.js` fetches the live Desmos bundle and applies the patches with the loader's own
`canonicalizeMatch`, checking each lands as often as it claims and that the result still parses.
Worth running after a Desmos deploy: a patch that matches nothing drops the whole extension for
that load, which here means a graph's cells show as raw notes. The Patch Helper tab is the
interactive version, and where to go when this says something has moved.

## The files

|             |                                                                                      |
| ----------- | ------------------------------------------------------------------------------------ |
| `index.js`  | what a cell is, where its text lives, when it is written back, and the `lua` trigger |
| `bridge.js` | the environment a cell runs in, reading the graph, and writing to it                 |
| `runner.js` | when a cell runs, the loop watchdog, and errors                                      |
| `editor.js` | Monaco - one instance, moved between cells - and the textarea it falls back to       |
| `test.js`   | the above; not loaded in the browser                                                 |
