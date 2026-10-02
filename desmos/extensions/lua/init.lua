-- The tables a cell is handed, written in Lua.
--
-- Everything here used to be built through fengari's C API, a lua_createtable and a dozen
-- lua_setfields at a time, in ./bridge.js. That is the wrong language for it: all of it is
-- table-and-metatable assembly, which Lua spells in one line where the C API spells it in six,
-- and the shape of the thing - what a cell starts with, what `_G` is, what `Desmos` is - was
-- spread across four functions and readable from none of them. It is one file now, and it reads
-- as what it is: a whitelist and four metatables.
--
-- ./bridge.js keeps what only it can do. Every function this file installs as a metamethod is
-- one of its C functions, handed in as `bridge` below, because each of them reaches the graph -
-- parks a coroutine on an unevaluated name, composes latex, writes an export. None of that is
-- expressible here. What is here is which function goes where.
--
-- **This chunk runs outside the sandbox it builds.** It is loaded with the real globals as its
-- environment - so `_G` on this line is fengari's own table, with `load`, `debug`, `io` and `js`
-- in it, and not the shared view a cell means by that name. That is the point: the whitelist
-- below has to be able to *read* the names it is deciding not to pass on. Nothing here is
-- reachable from a cell afterwards; a cell gets the tables this returns, and the locals that
-- built them are gone with the chunk.
--
-- Run once, when the graph opens - see bridge.boot(), which loads it, hands it `bridge`, and
-- files what it returns in the registry under the keys the rest of ./bridge.js reads.

local bridge = ...

-- ---------------------------------------------------------------------------
-- the lock
-- ---------------------------------------------------------------------------

-- What `getmetatable` answers with for anything this extension made. Built in JS rather than
-- here, because ./items.js and ./actions.js lock their own metatables with it through
-- `bridge.sealed` and both are asked for theirs while this chunk is still running - see the
-- handles further down.
local sealed = bridge.sealed

-- ---------------------------------------------------------------------------
-- the standard library
-- ---------------------------------------------------------------------------

-- What a cell starts with.
--
-- What is left out is left out on purpose. `debug` reaches upvalues and the registry and so
-- escapes any sandbox at all; `load`, `require` and `dofile` build an environment of their own;
-- `io`, `os.execute` and `package` are not this page's to offer. And `js` - fengari's bridge to
-- the page, and so to the DOM, `fetch` and every other global on this origin - is offered to
-- nothing and nobody. A cell reaches Desmos, and that is the whole of it.
--
-- The `raw*` family is in, and it is the one thing here that can be held wrong end up. A
-- `rawset` into `_G` lands in the empty table in front of the shared globals, where it shadows
-- the store for `_G.x` and is invisible to a bare `x` next door; a `rawset` into `Desmos`
-- replaces a function for every cell on the graph. Neither reaches past Desmos, so neither is
-- the sandbox's business - they are the sharp edge of a sharp tool, and reaching for `rawset` is
-- how you say you wanted one.
local GRANTED = {
    "assert",
    "error",
    "getmetatable",
    "ipairs",
    "next",
    "pairs",
    "pcall",
    "xpcall",
    "rawequal",
    "rawget",
    "rawlen",
    "rawset",
    "select",
    "setmetatable",
    "tonumber",
    "tostring",
    "type",
    "unpack",
    "math",
    "string",
    "table",
    "coroutine",
    "utf8"
}

-- ---------------------------------------------------------------------------
-- the three tables that outlive a run
-- ---------------------------------------------------------------------------

-- The shared globals. Not any cell's environment - those sit in front of this one - so that
-- every read and write still goes through a metamethod. ./bridge.js writes a global here and
-- reads one back out; nothing in Lua ever holds it directly.
local store = {}

-- The standard library, as one table every cell is seeded from *and* every `_G` lookup falls
-- back to. One table, because those two have to agree: `_G.print` being nil where `print` is a
-- function made `_G` look like an empty table, which is what it literally is - the values live
-- in the cell's own environment, and a lookup through the metatable never saw them.
--
-- Everything in it is shared between cells on purpose: `math` is `math` everywhere, and a cell
-- that rewrites its own `print` has rewritten the copy in its environment rather than this.
local safe = {}

-- `_G` itself: one table, shared by every cell, and the same metatable a cell's environment
-- wears. See `env` below for what it holds and why.
local globals = {}

-- ---------------------------------------------------------------------------
-- the environment a cell runs in
-- ---------------------------------------------------------------------------

-- `pairs`, for both a cell's environment and `_G`.
--
-- Without it `for k, v in pairs(_G)` finds nothing, because `_G` holds nothing: the values are
-- behind `__index`, and a rawget-based traversal never reaches a metamethod. So a snapshot is
-- built and Lua's own `next` walks that instead.
--
-- In the order a lookup would find them, so the snapshot says the same thing indexing does: the
-- standard library, then the shared globals every cell writes to, then what has been rawset into
-- `_G`, then whatever the cell's own table holds - the seeded copies.
--
-- `next` rather than `pairs` on each source, because `globals` and `env` wear this very function
-- as their `__pairs` and asking them politely would be asking this to walk itself.
--
-- **The graph is not in it.** `_G.a` answers for a name the sheet defines, and this does not
-- enumerate one: there is no list of them that is a list of *globals*, and asking for each value
-- is a read that can park the cell half way through a loop. The names are still there to be
-- asked for; what is not offered is discovering them this way.
local function walk(env)
    local snapshot = {}
    for _, source in ipairs({ safe, store, globals, env }) do
        for key, value in next, source do
            snapshot[key] = value
        end
    end
    return next, snapshot, nil
end

-- The metatable behind a cell's environment and behind `_G`. The same one, deliberately: that is
-- what makes "cell 2 sees what cell 1 defined" and "cell 2 re-runs when cell 1 changes it" fall
-- out of the same hook, and what makes `x = 1` and `_G.x = 1` one mechanism.
local environment = {
    __index = bridge.index,
    __newindex = bridge.newindex,
    __pairs = walk,
    -- Not readable from Lua, so a cell cannot lift those two out of it.
    __metatable = sealed
}

setmetatable(globals, environment)

-- ---------------------------------------------------------------------------
-- Desmos
-- ---------------------------------------------------------------------------

-- The one `Desmos`: reads like a global, writes reach the graph.
--
-- One table rather than one per cell, because `Desmos` and `_G.Desmos` have to be the same
-- object - a cell that reaches the second is asking for the first - and because a single object
-- is a single place to look when a builtin has to behave differently inside an action body.
--
-- `get`, `define`, `sample` and `type` are real fields and never reach a metamethod at all; so
-- are the three handles, which are the graph as objects rather than as values. A value has no
-- colour and a number cannot carry a metatable, so an item is a second thing to reach for - and
-- so are the graph's settings and its ticker, which are not values at all. See ./items.js.
--
-- `__index` is the graph and only the graph - the standard library is not on this path, so
-- `Desmos.math` is whatever the sheet calls `m_{ath}` - and `__newindex` is the strict door: it
-- errors where a plain global write would quietly store and move on.
local Desmos = setmetatable({
    get = bridge.get,
    define = bridge.define,
    sample = bridge.sample,
    type = bridge.typeOf,

    items = bridge.items,
    settings = bridge.settings,
    ticker = bridge.ticker
}, {
    __index = bridge.desmosIndex,
    __newindex = bridge.desmosNewIndex,
    __metatable = sealed
})

-- ---------------------------------------------------------------------------
-- filling the standard library in
-- ---------------------------------------------------------------------------

-- Straight off the real globals, which is what this chunk runs with. A name fengari does not
-- have - `unpack`, in 5.3 - is simply absent rather than an error.
for _, name in ipairs(GRANTED) do
    safe[name] = _G[name]
end

-- `_G` is the shared view rather than the real globals table: a cell writing `_G.x` is talking to
-- the other cells and to the graph, not to the page.
safe._G = globals

safe.point = bridge.point
safe.print = bridge.print
safe.warn = bridge.warn

-- `action(f)` hands `f` straight back and remembers it: the one way a cell says out loud that a
-- body is meant to change the graph rather than work out a value. Absent if ./actions.js is not
-- loaded, which is the same thing it was before.
safe.action = bridge.action

safe.Desmos = Desmos

-- ---------------------------------------------------------------------------
-- a cell's own table
-- ---------------------------------------------------------------------------

-- One per run, pushed as the chunk's `_ENV`.
--
-- Empty apart from the standard library, so *every* global read and write in the cell comes
-- through the metatable. The copy is what makes the chunk's own `print` a rawget: a cell that
-- shadows one of those names - `print = 1` - has shadowed its own copy rather than everyone's,
-- because `__newindex` does not fire for a key the table already holds. Everything else about
-- the table is shared, because everything else goes through the metatable.
--
-- The order here matters. Everything seeded goes in *before* the metatable does, so it lands in
-- this table and nowhere else. Setting any of it afterwards would go through `__newindex` into
-- the shared globals instead, publishing the standard library to every cell on the graph and
-- spinning the writing cell against its own write until the loop guard stopped it.
local function env()
    local fresh = {}
    for key, value in next, safe do
        fresh[key] = value
    end
    return setmetatable(fresh, environment)
end

-- string indexing
-- ("abc")[1] == "a"
do
    local strtable = debug.getmetatable("") or {}
    local old = strtable.__index or string
    if type(old) == "table" then
        function strtable:__index(i)
            if type(i) == "number" then
                return self:sub(i, i)
            end
            return old[i]
        end
    end
    debug.setmetatable("", strtable)
end

-- ---------------------------------------------------------------------------
-- what the registry keeps
-- ---------------------------------------------------------------------------

-- ./bridge.js files each of these under a registry key of its own and reads them back from
-- there. `value` is the metatable every value the graph answers with wears - a userdata rather
-- than a table, because `rawget` and `rawset` are granted and on a table those would reach
-- straight past the very hooks that read the graph.
return {
    store = store,
    globals = globals,
    safe = safe,
    desmos = Desmos,
    env = env,
    value = {
        __index = bridge.valueIndex,
        __newindex = bridge.valueNewIndex,
        __len = bridge.valueLen,
        __pairs = bridge.valuePairs,
        __call = bridge.valueCall,
        __tostring = bridge.valueToString,
        __eq = bridge.valueEq,
        __metatable = sealed
    }
}