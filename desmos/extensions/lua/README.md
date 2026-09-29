# Lua

Lua cells in the expression sheet. Pick **lua** from the `+` menu - next to note and table - or
type `lua` into an empty expression, and the row becomes an editor; a cell can read the graph's
values as ordinary globals and hand values back by assigning to `Desmos`.

## When a cell runs

Three times, and no others:

- when the graph opens;
- when you click the › in its gutter;
- when a value it read changes.

**Not when you edit it.** Typing is not a request to execute, and running on every keystroke would
run a dozen half-written versions of a line. `Ctrl`/`Cmd`+`Enter` or the › is how you say so.

Every cell, with nothing held back: opening somebody else's graph runs their Lua. That is only
tolerable because of what a cell can reach, which is the graph and nothing else - see _What a
cell can reach_.

## A cell

A cell is one of Desmos' own notes carrying a `lua: true` flag, and its `text` is the Lua source
verbatim. That is why it survives saving, undo, version history, `.dcg` files and desmos.com
without this extension teaching Desmos a new item type - and why, with the extension off, you
still see your Lua rather than losing it. The note's text _is_ the chunk: nothing is reassembled
and nothing is escaped, so Lua's line 3 is the editor's line 3.

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
all is looked for among them, so `sin(2)` and `arctan(1)` are Desmos' `\sin` and `\arctan`.
`Desmos.sin(2)` is the same thing said explicitly.

The fallback is only ever reached for a name that would otherwise be `nil`, so **the graph always
wins**: define `s_{in}` and `sin` means your value again, until you delete it.

| in Lua             | what it is                                                  |
| ------------------ | ----------------------------------------------------------- |
| `sin(2)`           | `0.909...`, via the fallback                                |
| `Desmos.mod(a, 3)` | `\operatorname{mod}\left(a,3\right)`, `a` being the graph's |
| `sqrt(x)`          | `\sqrt{x}`, `x` being a parameter                           |
| `log(x, 2)`        | `\log_{2}\left(x\right)` - the base is second               |
| `math.sin(2)`      | Lua's own, which never asks the graph anything              |

The list is Desmos' rather than one written down here: it is MathQuill's `autoOperatorNames`, read
through `Calc.controller.getMathquillConfig` the way `extensions/matrices` does. So a geometry
graph gets the geometry functions, the names `extensions/matrices` adds come along too, and none
of it goes stale when Desmos ships a build. `Desmos.get(latex)` is still there for anything the
list does not have.

**A builtin over numbers is a number.** `floor(random()*100)` is computed where it is written,
not written down as a formula for Desmos to evaluate later - which matters inside an action
body, where a formula would be re-evaluated on every fire. A builtin only becomes latex when one
of its arguments is not a number yet: a graph name a body read cold, or a parameter during the
export probe. `sqrt(x)` in a function being written down is `\sqrt{x}`; `sqrt(9)` is `3`.

A few are left to Desmos even over numbers, because their meaning is not one obvious line - the
distributions, `quantile`, `quartile`, `mad`, `erf`, `cov`, `corr`, `nCr`, `nPr`, `nthroot`, the
colour spaces. Those cost one trip to the evaluator, exactly as calling a graph function does.

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
Desmos.get("\\operatorname{mean}\\left(L\\right)")
```

A point comes back as `{x = 1, y = 2}` and a list of points as a list of those, which is the
same spelling a write takes - so `Desmos.q = Q` puts back what it read. In the 3D calculator a
point has a `z` as well.

Everything else Desmos writes down as numbers comes back as the numbers it is made of, nested
the way it is nested. A polygon is its list of points; a colour is its three numbers and a list
of colours is a list of those; a tone is two. Only the types made of _coordinates_ - points,
polygons, vectors, segments and triangles - turn their numbers into points, because an rgb
colour has three numbers too and calling it a point would be a guess at what it means.

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

A **function** is not one of these. It is a Desmos function, or an action - see below.

`Desmos.k = v` is the loud door. It asks for the graph outright rather than as a side effect of
forgetting `local`, so it **errors** rather than skipping:

```lua
Desmos.k = "hello"          -- error: a string is not a value
Desmos["1x"] = 1            -- error: not a name Desmos can parse
```

### Functions

A global function reaches the graph, and **what it becomes is written in the source** - there are
two ways to say "this changes the graph", and neither of them is silent:

```lua
function A(n) return n + 2 end              -- A\left(L_{p0}\right)=L_{p0}+2, a function
function a() return 1 end                   -- a\left(\right)=1, called from the sheet as a()
function B(n) return function() ... end end -- an action function: B(3) is an action
C = action(function() ... end)              -- an action: C is one, with no brackets
function D(n) a = n end                     -- an error: a function may not assign
```

A function **computes**. If it also moved the graph there would be no telling a helper that
assigned something once by accident from an action somebody meant, so assigning a Desmos name
from inside a plain function is refused where it is written:

```lua
function D(n)
    a = n   -- error: cannot assign "a" from a function
end
```

The two ways out are the two lines above it, and both are visible on the page.

The shape you write is the shape the graph gets. **A Lua function is a Desmos function and is
called with brackets**, even when it takes none, and a Lua value is a variable:

```lua
function a() return 1 end   -- a() on the sheet
b = 2                       -- b on the sheet
```

Writing the first as `a=1` would make it a variable that happens to hold the same number, and
there would be no way left to tell it from the second.

**A function that only computes is a Desmos function.** It is run once with its parameters
standing in as latex, so `n + 2` composes `L_{p0}+2` and what lands on the graph is a real Desmos
function - `A(3)` is `5`, it plots, and Desmos can differentiate it. There is no Lua left in it
once it has been written down, and no round trip when it is called.

**A name it reads stands for itself, not for what that name is worth right now.**

```dcg
b = 2
```

```lua
function A() return b + 1 end   -- A\left(\right)=b+1
```

```dcg
A()                  -- 3
A() with b = 1       -- 2
```

Writing down `A()=3` would be writing down a constant that happens to equal the right thing
today: `with` would have nothing to substitute into, and moving `b` would not move `A()` until the
cell ran again. So a graph read inside a function body composes latex even where the number is
already to hand.

A body that cannot be latex falls back to the numbers rather than to silence. `if b > 1 then` has
to know, and a fragment has no truth value, so the body is run a second time with the values it
asked for and written down _as it stands_. `with` cannot reach that one, and it is re-exported
whenever a name it read moves.

**`action(f)` is an action, and a function that hands back a function is an action function.**
The difference between them is what ends up on the sheet: `action(f)` exports a bare `C`, which
is what a button or a ticker means by an action, while `function B(n) return function() ... end
end` exports `B\left(n\right)`, so `B(3)` is an action and `B` on its own is not. Use the second
when the action needs an argument, and the first when it does not.

`action` hands `f` straight back - as far as Lua is concerned it is `function(f) return f end` -
so the body is still an ordinary function a cell can call. What it leaves behind is the note that
says which of the two things this is.

Neither kind can be written down as latex, so both keep a marker and run their Lua when they fire.
And **neither is ever handed an argument**. `B`'s arguments belong to `B`; the body that runs is
the one it handed back, which closes over them and takes none of its own. A body declared with
parameters it will never be given sees `nil`.

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
    return function()       -- the returned function is the action
        a = n               -- updates the a above
        b = f(a)            -- a is still 2 here
        return 3            -- ignored: an action has no value
    end
end
```

```dcg
X(4)                        -- click it: a becomes 4, b becomes the value of f(2)
```

Everything surprising about that example is the same one thing: **an action is simultaneous.**
Every right-hand side is computed against the state from before anything moved, so `b` is `f(2)`
and not `f(4)` even though `a = n` is written first - and `b` holds that as a number, not as the
expression that produced it. That is Desmos' rule, not
this extension's - `A = a\to a+1, b\to a` behaves the same way - and it is why the two lines can
be written in either order.

Two consequences follow from it:

- **a variable can only be updated once.** Adding `Y()` to the body above is an error naming `a`,
  because `Y` updates `a` too. Exporting the action runs the body once, so a duplicate the source
  spells out is reported there, before anything can be clicked; one that only shows up during a
  fire - because the action that ran this one moves the same name - stops the body where it
  happened and applies _nothing_. A half-moved graph is not a state anything gets to observe.
- **a value the graph has not produced yet cannot be branched on.** Rare, because the probe
  warms what a body reads before anything can fire, but it still holds for a value that depends
  on the action's own argument. See below.

An action a cell exports is reached from anywhere an action can be: a button, a ticker, another
cell. It runs at full speed under a ticker, because the Lua runs _inside_ Desmos' own fire rather
than a frame behind it.

A **local** is the cell's own, and none of this applies to it. `local function` reaches the graph
neither as an action nor as a function, and a local variable inside an action body may be assigned
as often as you like - the one-update rule is about the graph's names, not Lua's:

```lua
E = action(function()
    local t = 1
    t = t + 1   -- fine: t is nobody's but this body's
    a = t
end)
```

### What a body can see

**A body assigns values, not formulas.** Every right-hand side is computed at the moment it is
assigned, which is what a Desmos action does - `b\to f(\sin a)` puts the _number_ in `b`, and so
does the Lua that stands in for it. An assignment that left a formula behind would not be a
snapshot at all: edit `f` afterwards and `b` would move, which no action does.

Three things make that hold inside a fire, where the evaluator cannot be waited for:

- **arithmetic is Lua's.** `n + num`, and everything `math.*` does.
- **a builtin over numbers is computed where it is written**, by Desmos' own evaluator, running
  on this thread. `floor(random()*100)` is a number rolled once - not a formula rerolled on
  every fire.
- **a read of the graph is a number, because it was asked for in advance.** Exporting the
  function probes it, and the probe warms every value the body reaches for - `a`, and `f` at the
  argument the body gives it. By the time anything can fire, those have answers.

What is left over is **a latex fragment**: a value the graph has not produced _and_ was not
asked for in advance, which in practice means one that depends on the action's own argument.
`function X(n) return function() b = f(n) end end` cannot know `f(n)` until `n` arrives, so the
first fire assigns the
expression and warms it, and later fires with that same argument assign the number. Arithmetic
on a fragment composes more latex, and assigning it hands Desmos something to evaluate during
the same fire - which is exactly what `b\to f(4)` is, so the value is right either way.

There is one place a fragment is not right, and it is guarded rather than allowed: if the
fragment names the variable being assigned, the update would read as a definition in terms of
itself.

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
X = action(function()
    if Desmos.get("\\notyet") > 1 then a = 1 end   -- error: it is not a number yet
end)
```

The way out is to read it in the cell body, where a cell _can_ wait, and close over the number:

```lua
local threshold = Desmos.get("\\notyet")
X = action(function()
    if threshold > 1 then a = 1 end
end)
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

## Items

Reading a name gives you its _value_. `Desmos.items` gives you the item.

```lua
local myPolygon = Desmos.items.G
myPolygon.color = "#aabbcc"
myPolygon.lineStyle = "dashed"

Desmos.items.P.label = "this is a label!"
Desmos.items.P.showLabel = true
```

An item is found three ways: by the name it defines (`Desmos.items.G`), by its id
(`Desmos.items["17"]`), or by where it sits on the sheet (`Desmos.items[1]`, and `#Desmos.items`
for how many there are, so `ipairs` walks the graph). The name is tried first, because a name is
what a graph is written in; an id is what is left for the things that define no name, which is
most of what is worth styling - `y=x^{2}`, a circle, an image, a folder.

A handle is the same table every time, so `Desmos.items.P == Desmos.items.P` and one can be kept
in a local across a run.

Why not the value itself? Because most items have no value to hang it off. A number cannot carry
a metatable in Lua, `f(x)=x^{2}` is a function and neither can that, and `x^{2}+y^{2}=1` has no
name at all. The item is a second thing, and it is reached separately.

### What an item has

The property names are the **saved graph's** - what `getState()` calls them, nested where it
nests them. The _set_ comes from DesModder's text mode `@{ }` schema, which is the most complete
list of what a Desmos item is made of; the spellings do not, because text mode groups by what
reads well (`points: @{ size: ... }`) and this groups by what the state actually is
(`pointSize`).

|                    |                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| what it is         | `id`, `type`, `folderId`, `index`, `defines` - all read-only                                                                                                             |
| any item           | `hidden`, `secret`                                                                                                                                                       |
| an expression      | `latex`, `color`, `colorLatex`, `points`, `pointOpacity`, `pointSize`, `pointStyle`, `dragMode`, `lines`, `lineOpacity`, `lineWidth`, `lineStyle`, `fill`, `fillOpacity` |
| its label          | `label`, `showLabel`, `labelSize`, `labelOrientation`, `labelAngle`, `suppressTextOutline`, `interactiveLabel`, `editableLabelMode`                                      |
| and the rest of it | `displayEvaluationAsFraction`, `residualVariable`, `isLogModeRegression`                                                                                                 |
| a note             | `text`                                                                                                                                                                   |
| a folder           | `title`, `collapsed`                                                                                                                                                     |
| an image           | `image_url`, `name`, `width`, `height`, `center`, `angle`, `opacity`, `foreground`, `draggable`                                                                          |
| nested             | `slider`, `parametricDomain`, `polarDomain`, `parametricDomain3Du`/`3Dv`/`3Dr`/`3Dphi`, `cdf`, `clickableInfo`, `vizProps`                                               |

`defines` is the Desmos name the item defines, as Lua spells it - `W` for `W=7`, nil for
`x^{2}+y^{2}=1`. `index` counts from 1.

The nested ones are handles too:

```lua
local n = Desmos.items.N
n.slider.min = -5
n.slider.max = 25
n.slider.isPlaying = true

n.cdf = { show = true, min = 1, max = 2 }   -- or all at once
n.cdf = nil                                  -- and nil takes it off
```

- `slider`: `min`, `max`, `step`, `hardMin`, `hardMax`, `isPlaying`, `loopMode`,
  `animationPeriod`, `playDirection`
- every domain: `min`, `max`
- `cdf`: `show`, `min`, `max`
- `clickableInfo`: `enabled`, `description`, `latex`, `hoveredImage`, `depressedImage`
- `vizProps`: `breadth`, `axisOffset`, `alignedAxis`, `showBoxplotOutliers`, `dotplotXMode`,
  `binAlignment`, `histogramMode`

Left out: `glesmos`, `errorHidden` and `pinned`, which text mode also takes. Those are
DesModder's own, kept in an expression of its own rather than on the item, so setting one here
would mean nothing. A table's columns and a regression's parameters are not reachable either,
and there is no adding or deleting an item this way.

### Reading, and what a read costs

An unset property is `nil`, not the empty string the model holds - so `item.lineWidth or 2.5`
reaches its fallback. A width or a bound comes back as a **number** when that is what it is and
as the latex string when it is not: `2` for `2`, `"2a"` for `2a`.

A read is a dependency, the same as reading a value. A cell that read a colour is re-run when
that colour moves, whoever moved it - which needs saying, because nothing else would notice: a
style is not a value, so the evaluator never publishes one and no helper ever hears about it.
The graph's `change` event is the only word there is, and that is what `items.changed()` is
listening for.

### Writing, and what a write costs

Setting a property is **not** an export. Everything else this extension puts on the graph is a
statement that vanishes when the cell stops saying it; a colour is a property of somebody's real
item, so it is saved with the graph and it stays when the cell is deleted.

A write that would change nothing is not made at all. That matters more than it sounds: a cell
re-runs whenever anything it reads moves, and a cell that asserts a style does nothing on almost
every one of those runs.

Colours take `"#aabbcc"`, any CSS colour, or one of Desmos' own by name - `"red"` is
`#c74440`. Enums are matched without regard to case and stored the way Desmos spells them, which
is not consistent and is not ours to tidy: `pointStyle` is `OPEN` and `labelOrientation` is
`above`. Where Desmos publishes an object for exactly one of them - `Desmos.DragModes`,
`Desmos.LabelOrientations` - its values are accepted as well as the ones written down, so a
value Desmos has added since is not refused for being new.

Setting a property Desmos does not have is an **error**, unlike reading one:

```
an item has no "colour". Did you mean "color"?
cannot set "pointStyle": "round" is not one of POINT, OPEN, CROSS, SOLID, ...
```

It has to be. `setExpression` drops a property it does not recognise without a word, so a typo
that got through would look exactly like a line that did nothing.

### Two ways of writing

`Calc.setExpression` is the door, and it takes a fixed list: `color`, `hidden`, `latex`,
`label`, `pointSize`, `sliderBounds`, `parametricDomain` and about twenty more. Anything else it
is handed it silently ignores.

The rest is written onto the **item model**, which is what `getState()` is built from - so it is
saved with the graph and survives a state round trip, and `reparse()` is what makes the row and
the graph paper catch up. Which is which was measured against the live bundle rather than
guessed, and is marked property by property in `items.js`. The difference to a cell is that a
model write is not an undo step.

Numbers are written down as latex either way. A width, an opacity and a bound are all latex as
far as Desmos is concerned, and handing its parser a JavaScript number throws; `setExpression`
spells one for us and the model has nobody to do it, so `items.js` does it for both. The two
real numbers are `slider.animationPeriod`, in milliseconds, and `slider.playDirection`.

### An action cannot set one

```lua
Paint = action(function() Desmos.items.W.color = "blue" end)   -- not an action
```

An action is something Desmos runs on the graph, and a property of an item is not part of one -
so a body that sets one has nothing to update and is not exported. Asking for it with `action`
does not change that: the marker would have nothing to carry. Nothing is painted on the way to
finding that out, either - defining a function must not change the graph.

It is still an ordinary Lua function, and calling `Paint()` from a cell body does set the
colour. What cannot happen is a button on the sheet firing it.

## Settings and the ticker

The other two things DesModder's text mode hangs `@{ }` off, and they work the way items do.

```lua
Desmos.settings.showGrid = false
Desmos.settings.degreeMode = true
Desmos.settings.xAxisLabel = "time"
Desmos.settings.viewport = { xmin = -5, xmax = 5 }

Desmos.ticker.handlerLatex = "a \\to a+1"
Desmos.ticker.minStepLatex = 50
Desmos.ticker.playing = true
```

`Desmos.settings` has `degreeMode`, `complex`, `randomSeed`, `squareAxes`, `lockViewport`,
`showGrid`, `showXAxis`, `showYAxis`, `xAxisNumbers`, `yAxisNumbers`, `polarNumbers`,
`polarMode`, `restrictGridToFirstQuadrant`, `xAxisLabel`, `yAxisLabel`, `xAxisStep`, `yAxisStep`,
`xAxisMinorSubdivisions`, `yAxisMinorSubdivisions`, `xAxisArrowMode`, `yAxisArrowMode`, and the
3D calculator's `axis3D`, `speed3D`, `worldRotation3D`, `lockRotation` and `disableLighting`.
`product` is read-only - Desmos says so itself, in as many words.

`Desmos.settings.viewport` is `xmin`, `xmax`, `ymin`, `ymax` - moving one leaves the other three
where they are, because Desmos takes all four together. `zmin` and `zmax` can be read and not
set: they exist in the 3D calculator, `setMathBounds` is two dimensional, and a way of writing
them that could not be tried here is not one to ship.

`Desmos.ticker` is `handlerLatex`, `minStepLatex`, `playing` and `open`. Setting `playing` really
does start it ticking rather than only noting that something else had.

The same two ways of writing, for the same reason: `Calc.updateSettings` has a whitelist and
warns at the console about anything else, so `squareAxes` and the 3D five go onto the settings
model instead. Two of them the API and the model spell differently, and the API's word is used:
`lockViewport` is `userLockedViewport` on the model, and `lockRotation` is `userLockedRotation`.
This is the one place the "names are the saved graph's" rule bends, because nobody would guess
the other spelling.

Desmos also has rules about its settings that it keeps by **declining**, saying so at the
console and carrying on - it will not lock the viewport while the zoom buttons are showing, and
complex mode is in radians whatever `degreeMode` says. From a cell that looks like a line that
did nothing, so a setting is read back after it is written and the line says so itself:

```
Desmos would not set "lockViewport" - it is still false. There is usually a reason at the console
```

Reading a setting is a dependency like reading anything else, so a cell re-runs when the grid is
turned off underneath it - and that includes the viewport, so a cell that reads `viewport.xmax`
re-runs as the graph is panned.

## Keys

|                      |                                          |
| -------------------- | ---------------------------------------- |
| `Enter`              | a new line inside the cell               |
| `Shift`+`Enter`      | a new expression below the cell, focused |
| `Ctrl`/`Cmd`+`Enter` | run the cell now                         |
| `Esc`                | hand the row to Desmos                   |
| `Backspace`          | delete the cell, when it is empty        |
| › in the gutter      | run the cell; ⏸ while it runs, to stop   |

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

The note's own icon is replaced by a run button, wearing the glyph Desmos gives an action and
sitting where a slider's play button does: › while the cell is idle, ⏸ while a run is in flight.
Running a cell is the nearest thing the sheet already has a button for. The + menu's entry wears
the Lua mark instead - `dcg-icon-lua`, which is a class `index.css` defines over
`/cdn/media/dcg-icon-lua.svg`, because Desmos' icons are a font and there is no adding one to it
by name. It is drawn as a mask rather than a background image, so the mark takes `currentColor`
and follows the theme. Clicking mid-run stops it and withdraws what the part-finished run had
exported - a definition whose cell was interrupted is a value from nowhere. An action cannot be
stopped that way, which is the one place this button is a toggle where Desmos' is a flash.

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

### What autocomplete offers

Unqualified, it is the graph's names, Desmos' own functions, `action` and the `Desmos` members -
the same index a read goes through, so the list and what a name will actually do cannot disagree.

After a dot it is that dot's members, and only those:

| after                   | you get                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `Desmos.`               | `get`, `define`, `sample`, `items`, `settings`, `ticker`   |
| `Desmos.items.`         | the names the graph defines, which is how an item is found |
| `Desmos.items.P.`       | everything an item has, with what each one takes           |
| `...slider.`, `...cdf.` | that nested object's own, from anywhere it is reached      |
| `Desmos.settings.`      | every setting, and `viewport`                              |
| `Desmos.ticker.`        | its four                                                   |

Each entry says what it takes - `true or false`, `one of POINT, OPEN, CROSS`, `read-only` - and
which kind of item it belongs to, and both come out of the very tables `items.js` checks a write
against. There is no second list to fall out of date: an enum gains a value the moment Desmos
does, because the offer reads the same live `Desmos.Styles` the write does.

It follows literal paths only. `Desmos.items.P.slider.` knows what it is; a handle kept in a
local does not, unless the last thing before the dot is a nested object's name - `s.cdf.` works
because `cdf` is only ever one thing. Nothing here is a type checker, and a list that guessed
would be wrong about as often as it was right.

An error raised as something other than a string still says something. `error({})`, `error(nil)`
and a value with its own `__tostring` are all described rather than swallowed, and so is the one
that matters most: a JS exception thrown out of this extension's own code, which fengari hands
back as a userdata and which used to surface as the single word `error`. That now reads
`internal: TypeError: ...`, which is the difference between a bug you can find and one you
cannot. An error from an action names the action, because a fire is not a run and there is no
line just typed to tie it to.

## What a cell can reach

`_G` is the shared globals, not the page's: `_G.x = 1` is `x = 1`, and one cell's write is the
next cell's read. A lookup through it goes in order - what has been rawset into it, the shared
globals, the standard library, then the graph - and `pairs(_G)` walks a snapshot in that same
order. The graph is not in the snapshot. `_G.a` answers for a name the sheet defines, but
enumerating one means reading it, and a read can park the cell half way through a loop.

### rawset, and the two namespaces

`rawset(_G, "a", 1)` is a global like any other - the cell next door reads it as a plain `a` -
and it is the one way to make one **without touching the graph**:

```dcg
a = 2
```

```lua
rawset(_G, "a", 1)
```

```lua
a               -- 1, the Lua global
Desmos.a        -- 2, the sheet's, which kept its value
```

`Desmos.` is the graph's namespace and asks Lua nothing, which is what makes the two readable
side by side. A bare name is the Lua global if there is one and the graph's otherwise.

Which door a write goes through is Lua's own rule rather than a special case. `__newindex` fires
only for a key the table does not already hold, and an ordinary write is never kept in `_G` - it
goes to the shared globals and to the graph, every time, however often you make it. A name a
`rawset` put there _is_ held, so from then on assigning it - `a = 3` or `_G.a = 3`, either
spelling - is a plain write that stays in Lua.

A cell starts with `math`, `string`, `table`, `coroutine`, `utf8`, `pairs`/`ipairs`, `pcall`,
`select`, `tonumber`, `tostring`, `type`, `assert`, `error`, `getmetatable`, `setmetatable`,
`rawget`/`rawset`/`rawequal`/`rawlen`, `print`, `warn`, `action` and `Desmos` - the same objects
through `_G` as bare - plus
Desmos' own functions, as a fallback for any name the graph does not define. `Desmos` and
`_G.Desmos` are the same object.

**Globals are shared; locals are not.** Every cell reads and writes one set of globals, so a
function one cell defines is a function the next can call, and `_G` is a view of that set rather
than the page's own globals. A `local` belongs to the cell that declared it and to nothing else.

**A name the graph defines is the graph's.** Assigning one keeps a copy in the globals, so the
rest of that run reads what it just set - but the copy is dropped the moment the graph says the
name has moved, and the cell watches the graph for that whether or not it has a copy. Otherwise
a name Lua had once written would be a name Lua stopped watching, and an `a\to1` on the sheet
would move an `a` no cell ever heard about again.

How, since it matters if you move any of it: the globals live in a table of their own, and both
`_G` and each cell's environment are _empty_ tables in front of it wearing the same
`__index`/`__newindex`. A metatable on the table that also held the values could not do the job -
a `rawget` hit never reaches `__index`, so the second cell to read a name would be invisible and
nothing would ever re-run.

Left out: `debug` (it reaches upvalues and the registry, so it escapes any of this), `load`,
`require`, `dofile` (they build an environment of their own), `io`, `os` and `package`.

`rawget`, `rawset`, `rawequal` and `rawlen` are in, and they are the one place here you can hold
the tool by the blade. A `rawset` into `_G` lands in the empty table in front of the shared
globals, so `_G.x` finds it and a bare `x` in the cell next door does not; a `rawset` into
`Desmos` replaces a function for every cell on the graph. Neither reaches past Desmos, so neither
is the sandbox's business - reaching for `rawset` is how you say you wanted the sharp edge.

### Metatables

`getmetatable` and `setmetatable` are ordinary Lua and a cell gets both. What keeps this
extension's own objects out of reach is Lua's own lock rather than their absence: a metatable
with a `__metatable` field cannot be handed to `setmetatable` at all, and `getmetatable` returns
that field instead of the real table.

```lua
setmetatable({}, {__index = f})         -- yours: fine
setmetatable(Desmos.items.P, {})        -- error: cannot change a protected metatable
getmetatable(_G).__index = f            -- error: this is a locked metatable, not the real one
```

That field is one shared, empty, locked table - every object this extension makes answers with
the same one, it is its own metatable so there is no layer under it, and writing to it errors
rather than quietly changing something nothing consults. It used to be the string `"lua"`, which
locked just as well but read as a type error the moment anyone treated the result as a metatable.

The other half of granting `setmetatable` is that **a value on its way to the graph is read
raw**. A point is `{x = 1, y = 2}` and not a table that would produce those through `__index`:

```lua
Desmos.p = setmetatable({}, {__index = function(_, k) return k == "x" and 1 or 2 end})
-- error: an empty table has nothing to become
```

The conversion runs inside an action fire and inside JS callbacks, which are places Lua must not
run at all - so it reads what the table holds and never calls back into a cell to find out.

And `js` - fengari's interop, and through it `js.global`: this page, same-origin, with its
storage and its session. **It is granted to nothing.** There is no pragma, no flag and no cell
that gets it. A cell reaches the graph, and that is the whole of it.

There used to be a `--!lua unsafe` pragma that handed it over, and a rule that such a cell waited
for a click rather than running when the graph opened. Both are gone. A click is a poor control
for this: the graph is somebody else's code either way, the button says nothing about what the
cell will do with the page, and one kind of cell behaving differently from every other kind is a
sharp edge with nothing on the other side of it. An old graph with `--!lua unsafe` still on line
one loads fine - it is a Lua comment, and now that is all it is.

The standard library is seeded into a cell's environment _before_ that environment's metatable
goes on, which is what keeps it out of the shared globals: set afterwards it would go through
`__newindex` and be published to every cell on the graph. `test.js` checks that a cell cannot
reach `js`, `debug` or `load` by name, through `_G`, or by walking `pairs(_G)`.

## Loops

A cell that never finishes does not take the tab with it - it yields every few million
instructions and picks up on the next frame, and gives up after ten seconds. A cell that
re-runs more than twenty times while the graph settles is called a dependency loop and stopped.

A cell that writes a name it also reads is not one of those. `a = sin(a)` steps `a` once each
time the cell runs - the change it makes is its own doing, so it is not news to it, and the run
button is what applies it again.

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

- Anything the evaluator has numbers for can be read. A name it has no value for at all - a
  distribution, a name that errors - still reads as `NaN`.
- A polygon comes back as its points and a colour as its three numbers, so neither goes back as
  the thing it was: writing one puts a list on the graph, not a polygon.
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
  change to it - so firing the action is not one of the things that re-runs the cell, and
  `a = action(function() n = sin(n) end)` next to `n = 1` steps `n` on every `a` and returns it
  to 1 when the cell is run.
- What a body reads while it is being probed is warmed, not depended on. The exception is the
  one body written down with those numbers - `A()=10` for a body that branched on a graph value
    - which is re-exported when they move, because it is only right for as long as they are.
- A graph action _function_ cannot be called with arguments from inside another action's body -
  Desmos substitutes a function's arguments, and it has not started yet. Call it from the cell
  body, where it runs on its own.
- A value the evaluator has not produced yet is a latex fragment inside an action body, and
  comparing one errors. Exporting the body probes it and warms what it reads, so this is left
  to values that depend on the action's own argument - `f(n)` is unknown until `n` arrives. The
  first fire with a given argument assigns the expression and asks for it; the next one with
  that argument assigns the number. See _What a body can see_.
- A probe warms what a body reads, so a cell can run a few times over while those land. It is
  bounded: a body whose reads are different every run - `f(random())` - stops being waited for
  rather than looping.
- A function is written down by running it with its parameters standing in as latex. A body that
  compares one of those - `if n > 0 then` - has no single latex to be, so it is not exported at
  all. Comparing a _graph_ read is different: that one has a number to fall back on, and the body
  is written down as it stands today. `with` cannot substitute into it, and it is re-exported when
  the number moves.
- A function that assigns a Desmos name is an error, not an action. Say which you meant with
  `action(...)` or by returning a function; `local` is how you keep a name out of it entirely.
- An exported action's plumbing takes names of its own: `L_{uaN}` for the markers and `L_{p0}`,
  `L_{p1}` ... for the parameters. A graph that defines one of those itself has a duplicate
  definition, and Desmos will say so.
- Setting an item's property is not an export: it changes somebody's real item and is saved with
  the graph. Stopping a cell withdraws what it defined and leaves what it painted.
- Half of an item's properties are written onto the model rather than through `setExpression`,
  because `setExpression` ignores them. Those are not undo steps. Which half was measured
  against the live bundle, so a Desmos deploy that widens the API leaves this working and
  slightly out of date rather than broken.
- Two cells that set the same property to different values re-run each other until the loop
  guard stops them. A cell that sets one it also reads does not: its own write is not news to
  it, which is the rule everywhere else here too.
- `Desmos.items` reaches items, not their innards: a table's columns and a regression's
  parameters are not exposed, and there is no adding or deleting an item through it.
  `glesmos`, `errorHidden` and `pinned` are DesModder's own metadata rather than Desmos', so
  they are not there either.
- A cell that reads `Desmos.settings.viewport` re-runs whenever the graph is panned or zoomed,
  because the viewport really is part of the graph's state and `change` really does fire for it.
- The viewport's `zmin` and `zmax` can be read and not set; `setMathBounds` is two dimensional.
- Desmos declines some settings rather than refusing them - it will not lock the viewport while
  the zoom buttons show, and complex mode ignores `degreeMode`. Those come back as errors
  because the setting is read after it is written; a rule Desmos enforces some other way would
  not.
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

`test.js` runs index.js, builtins.js, bridge.js, items.js, actions.js and runner.js against the real VM out of
`cdn/fengari-web.js` and a stub `Calc` that reports values on a timer - so the pause-and-resume
path is exercised rather than assumed. No browser, nothing to install.

`patches.test.js` fetches the live Desmos bundle and applies the patches with the loader's own
`canonicalizeMatch`, checking each lands as often as it claims and that the result still parses.
Worth running after a Desmos deploy: a patch that matches nothing drops the whole extension for
that load, which here means a graph's cells show as raw notes. The Patch Helper tab is the
interactive version, and where to go when this says something has moved.

## The files

|               |                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------ |
| `index.js`    | what a cell is, where its text lives, when it is written back, and the `lua` trigger       |
| `builtins.js` | Desmos' own functions: the list, how each is spelled, and how one over numbers is computed |
| `bridge.js`   | the environment a cell runs in, reading the graph, and writing to it                       |
| `items.js`    | the graph as objects: `Desmos.items`, `Desmos.settings`, `Desmos.ticker`                   |
| `actions.js`  | actions both ways - recording a body, the markers, and applying updates                    |
| `runner.js`   | when a cell runs, the loop watchdog, and errors                                            |
| `editor.js`   | Monaco - one editor per cell - the gutter button, and the textarea it falls back to        |
| `test.js`     | the above; not loaded in the browser                                                       |
