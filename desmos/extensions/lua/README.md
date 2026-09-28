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

Desmos' own functions are reachable too, as a **fallback**: a name the graph does not define at
all is looked for among them, so `sin(2)` is `\sin\left(2\right)` and `arctan(1)` is
`\arctan\left(1\right)`. `Desmos.sin(2)` is the same thing said explicitly.

The fallback is only ever reached for a name that would otherwise be `nil`, so **the graph always
wins**: define `s_{in}` and `sin` means your value again, until you delete it.

| in Lua             | what it is                                     |
| ------------------ | ---------------------------------------------- |
| `sin(2)`           | `\sin\left(2\right)`, via the fallback         |
| `Desmos.mod(a, 3)` | `\operatorname{mod}\left(a,3\right)`           |
| `sqrt(x)`          | `\sqrt{x}`                                     |
| `log(x, 2)`        | `\log_{2}\left(x\right)` - the base is second  |
| `math.sin(2)`      | Lua's own, which never asks the graph anything |

The list is Desmos' rather than one written down here: it is MathQuill's `autoOperatorNames`, read
through `Calc.controller.getMathquillConfig` the way `extensions/matrices` does. So a geometry
graph gets the geometry functions, the names `extensions/matrices` adds come along too, and none
of it goes stale when Desmos ships a build. `Desmos.get(latex)` is still there for anything the
list does not have.

A builtin costs one trip to the evaluator, exactly as calling a graph function does - so
`math.sin` is the cheaper way to do arithmetic that does not need the graph.

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

Assign to a global. What that does depends on **who owns the name**, and the two cases are worth
telling apart because only one of them is new:

- a name **an expression on the sheet defines** is Desmos'. The assignment is an _update_, the
  same thing the action `a\to5` is - so a cell can move a slider that is already there instead of
  colliding with it.
- a name **nothing defines** is the cell's. It becomes a **statement in Desmos' evaluator** - not
  an expression in the list - which Desmos resolves exactly as it would a definition you had
  typed, but with no item on the sheet, nothing in the saved graph, and nothing on the undo stack.

```lua
a = 5                       -- the sheet has a=2: the 2 becomes a 5
k = 42                      -- nothing has k: k=42 appears, invisibly
```

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

A string, or a table that is neither a point nor a list of numbers, is **stored and not
exported**, quietly:

```lua
label = "hello"             -- a global, shared with every cell, on the graph nowhere
```

That silence is deliberate: a global write is how a cell shares anything at all, and erroring on
the ones the graph has no use for would make sharing the exception rather than the rule.

A **function** is not one of these. It is an action - see below.

`Desmos.k = v` is the loud door. It asks for the graph outright rather than as a side effect of
forgetting `local`, so it **errors** rather than skipping:

```lua
Desmos.k = "hello"          -- error: a string is not a value
Desmos["1x"] = 1            -- error: not a name Desmos can parse
```

### Functions

A global function reaches the graph, and **what it becomes depends on what it hands back**:

```lua
function A(n) return n + 2 end              -- A\left(L_{p0}\right)=L_{p0}+2, a function
function A(n) return function() ... end end -- an action
function X(n) a = n end                     -- an action: it updates something
```

**A function that only computes is a Desmos function.** It is run once with its parameters
standing in as latex, so `n + 2` composes `L_{p0}+2` and what lands on the graph is a real Desmos
function - `A(3)` is `5`, it plots, and Desmos can differentiate it. There is no Lua left in it
once it has been written down, and no round trip when it is called.

**A function that hands back a function is an action**, and so is one that updates a Desmos value.
The first is how you ask for an action outright; the second is what assigning to a Desmos name
already meant. Neither can be written down as latex, so those keep a marker and run their Lua when
they fire.

A body that can be neither - a recursive helper that branches on its own argument, say - is left
as what it already was: a Lua global the cell next door can call, and nothing on the graph. That
silence is the same one a string gets.

### An action

```dcg
a = 2
b = 1
Y = a \to 3
f(n) = n + arctan(n)
```

```lua
function X(n)
    a = n                   -- updates the a above, so X is an action
    b = f(sin(a))           -- a is still 2 here
    return 3                -- ignored: an action has no value
end
```

```dcg
X(4)                        -- click it: a becomes 4, b becomes f(sin(2))
```

Everything surprising about that example is the same one thing: **an action is simultaneous.**
Every right-hand side is computed against the state from before anything moved, so `b` is
`f(sin(2))` and not `f(sin(4))` even though `a = n` is written first. That is Desmos' rule, not
this extension's - `A = a\to a+1, b\to a` behaves the same way - and it is why the two lines can
be written in either order.

Two consequences follow from it:

- **a variable can only be updated once.** Adding `Y()` to the body above is an error naming `a`,
  because `Y` updates `a` too. The body stops there and the action applies _nothing_ - a
  half-moved graph is not a state anything gets to observe.
- **a value the graph has not produced yet cannot be branched on.** See below.

An action a cell exports is reached from anywhere an action can be: a button, a ticker, another
cell. It runs at full speed under a ticker, because the Lua runs _inside_ Desmos' own fire rather
than a frame behind it.

`local function` is how you say you meant none of this. A local is the cell's own, and nothing
about it reaches the graph - neither as an action nor as a function.

### What a body can see

A body runs during the fire, which is the one moment the evaluator cannot be waited for. So a
value inside a body is one of two things:

- **a number**, when the graph has already said what it is. Ordinary Lua: compare it, branch on
  it, loop over it.
- **a latex fragment**, when it has not. Arithmetic on it composes more latex, and assigning it
  hands Desmos an expression to evaluate during the same fire - which is exactly what
  `b\to\arctan(1)` is, so nothing is lost.

`b = f(sin(a))` is the second kind and is right either way. There is one place it is not, and it
is guarded rather than allowed: if the fragment names the variable being assigned, the update
would read as a definition in terms of itself.

```lua
function C(x)
    return function()
        m = n + m + x       -- with m cold this is `m=n+m+3`, which is not an update at all
    end
end
```

So a cold read on that line is an error saying to run it again, not a broken `m`. It is rare,
because the probe below warms `n` and `m` before anyone can click.

What a fragment cannot do at all is be compared:

```lua
function X(n)
    if Desmos.get("\\notyet") > 1 then a = 1 end   -- error: it is not a number yet
end
```

The way out is to read it in the cell body, where a cell _can_ wait, and close over the number:

```lua
local threshold = Desmos.get("\\notyet")
function X(n)
    if threshold > 1 then a = 1 end
end
```

In practice this rarely comes up: a cell that exports an action has its body run once at export
time, which is enough to start the graph computing everything the body reads. By the time anyone
clicks, those are numbers.

That run follows the function through. A body that hands back a function reads nothing itself -
everything is in the one it handed back - so that one is run too, and its reads are what get
warmed. `C` above reads `n` and `m` only on the inside, and they are watched from the moment the
cell runs.

### An action from the graph, in Lua

A Desmos action is a callable:

```lua
Y()                         -- from a cell body: runs it, now
```

Called from inside another body it does not run separately - its updates join the action already
in flight, against the same pre-action state. That is what makes the `Y()` above a
double-update error rather than two actions in a row.

### How an action actually runs

Worth knowing, because it is the one patch in this extension that is not about notes.

A cell cannot hand Desmos its Lua - the evaluator is a worker, and a closure is neither latex nor
on that thread. So the action a cell exports is a **marker**:

```
X\left(L_{p0}\right) = \left(L_{ua3}\to L_{p0}\right)
```

One marker variable per parameter, so the arguments ride in on the fire and a list argument still
works; a body with no parameters gets one marker that counts up, because an action has to update
something. The markers are Lua-owned names like any other, published as statements.

Desmos applies an action's updates in one loop, calling `updateLatexForIdentifier` for each. That
loop is what `index.js` patches: seeing a marker among the updates means the body runs _there_,
inside the same fire, with whatever it records folded into the same map. So Desmos applies its
updates and Lua's together - no frame of lag, one pre-action state behind every right-hand side,
and a target named twice caught before anything moves. An action with no Lua in it walks straight
past.

The marker itself is taken back out of the map. It exists to be noticed, not to be applied.

### When the function is too Lua to write down

A body that branches on its argument, builds a string, or loops a variable number of times has no
latex, so it cannot be exported as a Desmos function - it stays a Lua global and the graph never
sees it. These two are the way to get such a thing onto the graph anyway, and both work by
producing latex up front rather than asking Desmos to call Lua:

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
`select`, `tonumber`, `tostring`, `type`, `assert`, `error`, `print`, `warn` and `Desmos` - plus
Desmos' own functions, as a fallback for any name the graph does not define. `Desmos` and
`_G.Desmos` are the same object.

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
- A button you type cannot reach a name only a cell defines. There is no item behind such a name
  for Desmos to rewrite, so the update has nowhere to land; a name an expression defines takes one
  from anywhere.
- A cell that both defines a name and exports an action updating it puts the name back to what the
  cell body says whenever the cell re-runs. The cell body is the definition; the action is a
  change to it.
- A graph action _function_ cannot be called with arguments from inside another action's body -
  Desmos substitutes a function's arguments, and it has not started yet. Call it from the cell
  body, where it runs on its own.
- A value the evaluator has not produced yet is a latex fragment inside an action body, and
  comparing one errors. See _What a body can see_.
- A function is written down by running it once with its parameters standing in as latex. A body
  that compares one of those - `if n > 0 then` - has no single latex to be, so it is not exported
  at all unless it also updates something, in which case it is an action.
- An exported action's plumbing takes names of its own: `L_{uaN}` for the markers and `L_{p0}`,
  `L_{p1}` ... for the parameters. A graph that defines one of those itself has a duplicate
  definition, and Desmos will say so.
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

`test.js` runs index.js, builtins.js, bridge.js, actions.js and runner.js against the real VM out of
`cdn/fengari-web.js` and a stub `Calc` that reports values on a timer - so the pause-and-resume
path is exercised rather than assumed. No browser, nothing to install.

`patches.test.js` fetches the live Desmos bundle and applies the patches with the loader's own
`canonicalizeMatch`, checking each lands as often as it claims and that the result still parses.
Worth running after a Desmos deploy: a patch that matches nothing drops the whole extension for
that load, which here means a graph's cells show as raw notes. The Patch Helper tab is the
interactive version, and where to go when this says something has moved.

## The files

|               |                                                                                      |
| ------------- | ------------------------------------------------------------------------------------ |
| `index.js`    | what a cell is, where its text lives, when it is written back, and the `lua` trigger |
| `builtins.js` | Desmos' own functions: the list, read off Desmos, and how each one is spelled        |
| `bridge.js`   | the environment a cell runs in, reading the graph, and writing to it                 |
| `actions.js`  | actions both ways - recording a body, the markers, and applying updates              |
| `runner.js`   | when a cell runs, the loop watchdog, and errors                                      |
| `editor.js`   | Monaco - one editor per cell - the gutter button, and the textarea it falls back to  |
| `test.js`     | the above; not loaded in the browser                                                 |
