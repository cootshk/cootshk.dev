# Lua

Lua cells in the expression sheet. Pick **lua** from the `+` menu - next to note and table - or
type `lua` into an empty expression, and the row becomes an editor; a cell can read the graph's
values as ordinary globals and hand values back by assigning to `Desmos`.

## When a cell runs

Three times, and no others:

- when the graph opens;
- when you click the ▶ in its gutter;
- when a value it read changes.

**Not when you edit it.** Typing is not a request to execute, and running on every keystroke would
run a dozen half-written versions of a line. `Ctrl`/`Cmd`+`Enter` or the ▶ is how you say so.

The one thing that does not run at load is a cell asking for `unsafe`, which is handed the page
itself - see _What a cell can reach_. Everything else on a graph you have just opened runs, which
means opening somebody else's graph runs their Lua.

## A cell

A cell is one of Desmos' own notes carrying a `lua: true` flag, and its `text` is the Lua source
verbatim. That is why it survives saving, undo, version history, `.dcg` files and desmos.com
without this extension teaching Desmos a new item type - and why, with the extension off, you
still see your Lua rather than losing it. The note's text _is_ the chunk: nothing is reassembled
and nothing is escaped, so Lua's line 3 is the editor's line 3.

An optional first line names pragmas, and there is one pragma - `unsafe`:

```lua
--!lua unsafe
Desmos.k = a * 2
```

It is read and then left exactly where it is. `--!lua` is a Lua comment, so the compiler ignores
it and no line numbers have to be adjusted.

Desmos has no typed-word conversions of its own - `table` is not one either, whatever the
folklore says - so the `lua` trigger is this extension's. It fires the moment an expression's
latex is exactly `lua`, which means you cannot type `lua` as a product of three variables, and
cannot type a longer name that passes through it on the way: `lua` converts before the `p` of
`luap` arrives. Undo gives the expression back.

The `+` menu is the route that does not depend on any of that, and
`Extensions.lua.add()` from the console is a third.

## How a cell is marked

Two patches, both only about making the flag persist:

| site  | what it needed                                                               |
| ----- | ---------------------------------------------------------------------------- |
| `l0e` | a note's saved state is built from a fixed field list; `lua` is added to it. |
| `s0e` | its undo restoration copies a fixed prop set; `lua` is added to that too.    |

Everything else is a note, natively. Three things make the flag survive on its own, and are
worth knowing before moving it anywhere: the state normaliser is a deep clone; the
strip-defaults pass iterates the _object_ rather than the defaults, so a key the defaults have
never heard of is kept; and `setExpression` applies only the fields it is handed, so writing
`text` back does not disturb `lua`. `text` carries the source for the same reason the flag is
cheap - `text` is already in both of those lists.

### Why not `type: "lua"`

It was, briefly, and it is a trap worth writing down. Desmos asks what an item type is in some
fifty places. A custom type has to answer seventeen of them, and **seven of those are `for`
loops over every item model whose `switch` ends in `default: return`** - which do not skip a
type they have not met, they end the loop, so every item _after_ a cell silently stops being
updated. One of them is the per-frame update that populates `cachedViewState`, which is what
`getState()` reads: unpatched, a cell rendered as an empty row and never appeared in the saved
graph at all. Another is `requestParseForAllItems`, which is where this extension injects its
own exports - so a cell broke its own statements.

Twenty-two patches versus eight, a failure mode that corrupts unrelated expressions, and no
graceful degradation. desmos.com was never the obstacle either - the server stores `state` as an
opaque JSON string and does no schema validation, so a custom type round-trips through a
snapshot link byte for byte. The client was the whole problem.

## Reading the graph

Any Desmos name is a global. A Desmos identifier is one letter and an optional subscript, so
**everything after the first letter is the subscript**:

| in Lua  | on the graph |
| ------- | ------------ |
| `a`     | `a`          |
| `a1`    | `a_{1}`      |
| `abcd`  | `a_{bcd}`    |
| `a_bcd` | `a_{bcd}`    |

The last two are the same name; write whichever reads better. A name that cannot be a Desmos one
at all - `_x`, `1x` - is never asked about, which is what keeps `pairs` and `_G` off the graph.

Desmos' own built-ins are **not** reachable this way: `sin` means `s_{in}`, not `\sin`. Use
`math.sin`, or `Desmos.get("\\sin(2)")`.

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

A name **nothing on the graph defines** is `nil`, straight away, and costs nothing. That matters
more than it looks: waiting on it would report `NaN`, and `NaN` is a number and so truthy, which
would quietly break `if not cache then cache = {} end`.

Whatever a cell reads becomes what it watches. Change `a` and every cell that read `a` runs
again by itself. That includes globals from other cells - one cell's `base = 10` is another
cell's `base`, and changing it re-runs the reader.

`Desmos.get(latex)` is the way to read anything that is not a plain name:

```lua
Desmos.get("\\sin(2)")
Desmos.get("\\left(P\\right).x")   -- a point's components; see Limits
```

### Calling a function the graph defines

A Desmos `f(x) = x^{2}` is a Lua function:

```lua
Desmos.y = f(3)             -- 9
```

Each distinct argument is its own trip to the evaluator, so a Lua loop over a hundred values is a
hundred round trips and will feel like it. Desmos functions take lists, and a Lua table becomes
one - so pass the lot at once and get a list back:

```lua
local ys = f({1, 2, 3})     -- {1, 4, 9}, in one trip
```

## Writing to the graph

Assign to a global. Each assignment becomes a **statement in Desmos' evaluator** - not an
expression in the list. Desmos resolves it exactly as it would a definition you had typed, but
there is no item on the sheet, nothing in the saved graph, and nothing on the undo stack.

How: `requestParseForAllItems()` builds a map of everything on the graph with latex in it, then
diffs that map against the previous one and calls the evaluator's `addStatement` /
`removeStatement` for whatever changed. One patch injects the cells' exports into that map at
the last moment before the diff (`index.js`). The reaper comes free with it - an export a cell
no longer makes is simply absent from the map, so Desmos removes the statement itself.

```lua
k = 42                      -- k=42
v = {1, 2, 3}               -- v=\left[1,2,3\right]
p = {x = 1, y = 2}          -- p=\left(1,2\right)
q = {{x=0,y=0}, {x=1,y=1}}  -- a list of points
total = 7                   -- t_{otal}=7
k = nil                     -- and it is gone
```

`_G.k = 42` and `Desmos.k = 42` do the same thing. All three go through one metatable, and
`local` is how you say you meant none of it.

### Values with no Desmos spelling

A function, a string, or a table that is neither a point nor a list of numbers is **stored and
not exported**, quietly:

```lua
function fact(n) ... end    -- a global, shared with every cell, on the graph nowhere
label = "hello"             -- likewise
```

That silence is deliberate. `function f(x) ... end` is a global write like any other, and
erroring on it would error on cross-cell functions, which is most of the point of sharing globals.

`Desmos.k = v` is the loud door. It asks for the graph outright rather than as a side effect of
forgetting `local`, so it **errors** rather than skipping:

```lua
Desmos.k = "hello"          -- error: a string is not a value
Desmos["1x"] = 1            -- error: not a name Desmos can parse
```

### Functions

**A Lua function cannot become a Desmos function.** It works the other way round - a Desmos `f(x)`
_is_ callable from Lua, see above - but not this way. Values are one thing: a statement's latex is
just text, so a number or a list travels fine. A _call_ is another: Desmos evaluates in a worker,
and wants derivatives, interval arithmetic and list broadcasting from anything it calls. A closure
gives it none of those, and it is on the wrong thread besides. Two things work instead.

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

## Keys

|                      |                                          |
| -------------------- | ---------------------------------------- |
| `Enter`              | a new line inside the cell               |
| `Shift`+`Enter`      | a new expression below the cell, focused |
| `Ctrl`/`Cmd`+`Enter` | run the cell now                         |
| `Esc`                | hand the row to Desmos                   |
| `Backspace`          | delete the cell, when it is empty        |
| ▶ in the gutter      | run the cell; ⏸ while it runs, to stop   |

After `Esc` the row belongs to the expression sheet again, so Desmos' own keys work on it -
`Enter` for a new line below, up and down to walk to the neighbouring ones. `Shift`+`Enter` is
that pair in one press.

Desmos keeps focus as state rather than as DOM focus, so `Esc` dispatches `set-selected-id` and
`move-focus-to-item` - its own "focus this row" - and then puts DOM focus on **the note's own
textarea**, which is where Desmos' navigation for a note lives. The row container will not do:
`tabIndex: -1` makes it focusable, but its `keydown` only handles reorder mode, so focusing it
leaves the arrows dead. This is why `index.css` shrinks that textarea to a point and makes it
click-through instead of hiding it.

Clicking into a cell dispatches `set-selected-id` on its own, so Desmos' blue marker follows the
row you are typing in - selection only, since `move-focus-to-item` would have Desmos take the
keyboard straight back off the editor.

`Tab` and any printable character are the ways back in, matching what they do over an expression:
`Tab` places the caret, and typing starts editing. Both are handled on the row rather than on the
box, because the two things that can hold the keyboard when the editor does not - Desmos' item
container and the note's textarea - are both inside the row and outside the box; an event from
inside the box is the editor's own, where `Tab` indents.

A typed character arrives with the keystroke already cancelled, so it is inserted by hand rather
than left to land. The row's own textarea is also made read-only: it still holds the cell's
source, so anything the keys above do not catch - a paste, say - would otherwise be spliced
straight into it by Desmos' note editing and turn up in the code box.

Arrows, `Enter` and `Backspace` are otherwise held inside the editor, because Desmos binds all
three to moving around the list. `Backspace` with nothing left to delete is the exception, and
it is handed to Desmos rather than answered here: `on-special-key-pressed` is what an empty
expression's own `Backspace` dispatches, so an empty cell is deleted on the same terms as an
empty expression - not when it is the only item left, out of its folder first if it is the last
thing in one, and leaving the caret at the end of the row above. The pending write is flushed
before the row goes, because `setExpression` creates an id it cannot find: a write that landed
after the delete would put the row back as a plain note.

## The gutter, `print` and errors

The note's own icon is replaced by a run button, in the same place and the same size a slider's
play button sits: ▶ while the cell is idle, ⏸ while a run is in flight. Clicking mid-run stops it
and withdraws what the part-finished run had exported - a definition whose cell was interrupted is
a value from nowhere.

That button is not a bundle patch. The row is already this extension's to decorate, and
`attach()` is re-run whenever React rebuilds one. Taking the click off the drag handle underneath
it needs `tapboundary="true"` rather than `stopPropagation`: Desmos' tap dispatcher walks the
element chain outwards from the pointer and fires on the first element whose rect contains it,
stopping at any element carrying that attribute. It is Desmos' own convention for a control nested
inside another.

An error turns the same icon into Desmos' error icon, because it is Desmos' own markup -
`div.dcg-tooltipped-error > i.dcg-icon-error`, which is exactly what an expression's error is - so
the colour, the size and the fade-in come for free. The message is on the icon's `title` and, when
Monaco loaded, squiggled under the line it names. The button stays clickable either way, so a cell
can be run again once its error is fixed.

`print` goes to `console.log` and `warn` to `console.warn`. There is no strip under the cell.

## What a cell can reach

A cell starts with `math`, `string`, `table`, `coroutine`, `utf8`, `pairs`/`ipairs`, `pcall`,
`select`, `tonumber`, `tostring`, `type`, `assert`, `error`, `print`, `warn` and `Desmos`.

**Globals are shared; locals are not.** Every cell reads and writes one set of globals, so a
function one cell defines is a function the next can call, and `_G` is a view of that set rather
than the page's own globals. A `local` belongs to the cell that declared it and to nothing else.

How, since it matters if you move any of it: the globals live in a table of their own, and both
`_G` and each cell's environment are _empty_ tables in front of it wearing the same
`__index`/`__newindex`. A metatable on the table that also held the values could not do the job -
a `rawget` hit never reaches `__index`, so the second cell to read a name would be invisible and
nothing would ever re-run.

Left out: `debug` (it reaches upvalues and the registry, so it escapes any of this), `load`,
`require`, `dofile` (they build an environment of their own), `io`, `os` and `package`.

`js` - the whole DOM, through fengari's interop - is behind a pragma:

```lua
--!lua unsafe
js.global.console:log("hello")
```

That is real: `js.global` is this page, same-origin, with its storage and its session. A cell
with `unsafe` on it can do anything a script on cootshk.dev can do. So it is the one kind of cell
that **does not run when the graph opens** - it waits for a click, which is the control that
matters.

`js` is seeded into the cell's own environment _before_ that environment's metatable goes on, and
that ordering is the whole of the guarantee. Set afterwards it would go through `__newindex` into
the shared globals, handing the DOM to every cell on the graph the moment one asked for it.
`test.js` checks a safe cell next to an unsafe one for exactly that.

## Loops

A cell that never finishes does not take the tab with it - it yields every few million
instructions and picks up on the next frame, and gives up after ten seconds. A cell that
re-runs more than twenty times while the graph settles is called a dependency loop and stopped;
that is easy to build by exporting a value the same cell reads.

What this does not catch is a single expensive call - `string.rep("x", 1e9)` is one Lua
instruction and will still hurt.

## Two bugs worth not reintroducing

Both were in the editor, and both came from the same idea: _one_ Monaco moved into whichever
cell had focus, with every other cell showing a `<pre>` coloured by `monaco.editor.colorize`.
It is cheaper, and it is wrong twice:

- focusing a cell replaced the very element the click had landed on, so the click never reached
  the editor and it took several to get in;
- and leaving a cell rebuilt its box from `cell.source`, which turned any bug anywhere near that
  value into the cell's text visibly disappearing.

One editor per cell has neither, because nothing is ever re-derived: the Monaco model _is_ the
text. `test.js` asserts that shape so it does not come back as an optimisation.

The value bug underneath the second one is worth knowing separately, because it will bite
anything else that reads the graph back: **`getState()` is a frame stale.** `setExpression` sets
an item model's `text` immediately, but `getState()` reads `cachedViewState`, which Desmos
rebuilds once a frame. Read back inside the frame you wrote in, it reports the _previous_ text -
which looks exactly like someone else editing underneath you. `index.js` reads
`Calc.controller.getAllItemModels()` instead, and there is a test that fails if that is ever
swapped back.

## Limits

- Numbers and lists of numbers can be read. A point reads as `NaN`; use
  `Desmos.get("\\left(P\\right).x")`.
- A name the graph defines but the evaluator cannot value reads as `NaN`. A name the graph does
  not define at all reads as `nil`; the two are worth telling apart.
- A Desmos function called from Lua costs one trip to the evaluator per distinct argument. Pass a
  list to do many at once.
- A cell that reads a value from somewhere it cannot pause - a `js` callback, `table.sort`'s
  comparator - takes `nil` that once and is re-run from the top when the value arrives.
- An export is invisible: there is no row to click, so a wrong value has to be debugged from the
  cell that made it. Stopping a run withdraws everything that run had defined.
- Nothing watches for a name being read that a _later_ helper would answer differently once
  evicted: past five hundred watched latexes the oldest unparked ones are let go, and a read of
  one of those starts over.
- Cells _start_ in sheet order. They do not finish in it, because any of them may pause on a
  read. "A later cell sees an earlier cell" is the rule that holds.
- Monaco comes from jsDelivr. Without it a cell is a plain textarea - editing, saving and
  running all still work; the colours and the error squiggles do not.
- One Monaco editor per cell, built when the row appears and disposed when it scrolls away. The
  model outlives the row, so scrolling costs no undo history, and the number of live editors is
  bounded by what is on screen rather than by how many cells the graph has.

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
| `editor.js` | Monaco - one editor per cell - the gutter button, and the textarea it falls back to  |
| `test.js`   | the above; not loaded in the browser                                                 |
