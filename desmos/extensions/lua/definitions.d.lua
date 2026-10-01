---@meta

---Anything (except raw numbers) returned from a Desmos graph (i.e. points, polygons, tones, lists, actions, etc.)
---@class DesmosValue : userdata

---A point from Desmos (either 2D or 3D)
---A point is 3D if `point.z` is truthy..
---@class DesmosPoint : DesmosValue
---@field x number
---@field y number
---@field z number|nil Only for 3D points.

---All of the possible return values of `Desmos.type`.
---This is a superset of Lua's vanilla `type`.
---@alias DesmosTypes
---| "nil"
---| "boolean"
---| "number"
---| "string"
---| "table"
---| "function" # Includes both Lua and Desmos functions
---| "thread"
---| "userdata" # something of ours with no better word
---| "list"
---| "point"
---| "single_point"
---| "point_list"
---| "point3d"
---| "point3d_list"
---| "polygon"
---| "vector2d"
---| "vector3d"
---| "segment3d"
---| "triangle3d"
---| "action" # an action the graph defines
---| "latex" # a half-known value inside an action body
---| "item"
---| "settings"
---| "ticker"
---| "viewport"
---| "slider"
---| "cdf"
---| "clickableInfo"
---| "vizProps"
---| "parametricDomain"
---| "polarDomain"
---| "parametricDomain3Du"
---| "parametricDomain3Dv"
---| "parametricDomain3Dr"
---| "parametricDomain3Dphi"
---| string # anything else Desmos' expression_type says

---@alias latex string
---@alias expression number|latex

---@alias DesmosLoopMode "LOOP_FORWARD_REVERSE"|"LOOP_FORWARD"|"PLAY_ONCE"|"PLAY_INDEFINITELY"
---@alias DesmosArrowMode "NONE"|"POSITIVE"|"BOTH"
---@alias DesmosAlignedAxis "x"|"y"
---@alias DesmosDotplotXMode "exact"|"binned"
---@alias DesmosBinAlignment "left"|"center"
---@alias DesmosHistogramMode "count"|"relative"|"density"

---A slider's properties
---`min`, `max` and `step` also set `hardMin` and `hardMax`.
---@class DesmosSlider
---@field min expression
---@field max expression
---@field step expression
---@field hardMin boolean
---@field hardMax boolean
---@field isPlaying boolean
---@field loopMode DesmosLoopMode
---@field animationPeriod number Milliseconds.
---@field playDirection number 1 or -1.

---The range a parametric or polar expression is drawn over.
---@class DesmosDomain
---@field min expression
---@field max expression

---A distribution's cumulative shading.
---@class DesmosCdf
---@field show boolean
---@field min expression
---@field max expression

---What a clickable expression does when it is pressed.
---@class DesmosClickable
---@field enabled boolean
---@field description string
---@field latex string The action to run.
---@field hoveredImage string
---@field depressedImage string

---A statistical plot (histogram, dotplot, boxplot)
---@class DesmosVizProps
---@field breadth expression
---@field axisOffset expression
---@field alignedAxis DesmosAlignedAxis
---@field showBoxplotOutliers boolean
---@field dotplotXMode DesmosDotplotXMode
---@field binAlignment DesmosBinAlignment
---@field histogramMode DesmosHistogramMode

---The viewport
---@class DesmosViewport
---@field xmin number
---@field xmax number
---@field ymin number
---@field ymax number
---@field zmin number? Only in 3D.
---@field zmax number? Only in 3D.

---One line of the expression sheet.
---Its properties are the saved graph's own - `color`, `hidden`, `latex`, `label`, `lineWidth`,
---`pointStyle`, `slider`, and about forty more. Reading one the item does not have gives `nil`;
---setting one is an error, because a typo that went through would look exactly like a line that
---did nothing. `tostring(item)` is the item's own latex.
---@class DesmosItem
---@field id string Desmos' own id for this row. Read-only.
---@field [string] any
---@field slider DesmosSlider
---@field parametricDomain DesmosDomain
---@field polarDomain DesmosDomain
---@field parametricDomain3Du DesmosDomain
---@field parametricDomain3Dv DesmosDomain
---@field parametricDomain3Dr DesmosDomain
---@field parametricDomain3Dphi DesmosDomain
---@field cdf DesmosCdf
---@field clickableInfo DesmosClickable
---@field vizProps DesmosVizProps
---@field color string?
---@field hidden boolean?
---@field latex latex?
---@field label string?
---@field lineWidth number?
---@field pointStyle any?

---The expression sheet.
---Properly implements length, `pairs`, and `ipairs`.
---@class DesmosItems
---@field [integer] DesmosItem by line number
---@field [string] DesmosItem variables defined in Desmos.
local DesmosItems = {}

---The graph's settings.
---@class DesmosSettings
---@field product string Read-only: which calculator this is.
---@field viewport DesmosViewport|{xmin: number?, xmax: number?, ymin: number?, ymax: number?} Able to be directly and/or partially set (`Desmos.settings.viewport = {xmin = -10, xmax = 10}`)
---@field degreeMode boolean
---@field complex boolean
---@field randomSeed string
---@field squareAxes boolean
---@field lockViewport boolean
---@field showGrid boolean
---@field showXAxis boolean
---@field showYAxis boolean
---@field xAxisNumbers boolean
---@field yAxisNumbers boolean
---@field polarNumbers boolean
---@field polarMode boolean
---@field restrictGridToFirstQuadrant boolean
---@field xAxisLabel string
---@field yAxisLabel string
---@field xAxisStep number
---@field yAxisStep number
---@field xAxisMinorSubdivisions number
---@field yAxisMinorSubdivisions number
---@field xAxisArrowMode DesmosArrowMode
---@field yAxisArrowMode DesmosArrowMode
---@field axis3D number[] Three numbers (3D only)
---@field speed3D number 3D only
---@field worldRotation3D number[] Nine numbers (3D only).
---@field lockRotation boolean 3D only.
---@field disableLighting boolean 3D only.

---Creates a new point.
---The Lua alterntive to `(1, 2)` in the expression sheet.
---```lua
---Desmos.P = point(1, 2)
---print(point(1, 2).x)
---```
---@param x number
---@param y number
---@param z? number
---@return DesmosPoint
function point(x, y, z) end

---Creates an action from a Lua function.
---By default, Lua functions are turned into Desmos functions, which have the restriction of not being able to update variables. 
---This turns a Lua function into an action, which is able to update values at the cost of not returning anything.
---```lua
---A = action(function() b = b + 1 end)
---```
---
---Both actions and functions are of the function type in Lua. (TODO: change this.)
---@param body function
---@return function
function action(body) end

---Prints to the browser console.
---@see console.log
---@param ... any
function print(...) end

---Warns to the browser console.
---@see console.warn
---@param ... any
function warn(...) end

---The Desmos object allows references to the Desmos graph.
---Indexing fields of this graph attempts to retrieve Desmos variables, such that `Desmos["abcd"]` returns `a_{bcd}`.
---@class Desmos
Desmos = {}

---Evaluates a given LaTeX string.
---```lua
---Desmos.get [[\operatorname{polygon}\left(A,B,C\right)]]
---```
---@param latex latex
---@return number|DesmosValue?
function Desmos.get(latex) end

---Write an expression's latex yourself.
---`lhs` is the left-hand side (`"g(x)"`, `"k"`) and `rhs` its latex. 
---```lua
---Desmos.define("g(x)", "x^{2}+1")
---```
---@param lhs latex
---@param rhs latex
---@param plot? boolean If the expression should be placed onto the graph
function Desmos.define(lhs, rhs, plot) end

---Plot a Lua function as sampled points.
---`n` points with straight lines between them, and no derivative.
---`name` is the Desmos name to publish it under, and `n` is how many points to take - 2 to
---10000, and 200 if it is left out.
---
---```lua
---Desmos.sample("g", function(x) return x * x end, 0, 10, 200)
---```
---@param name string
---@param f fun(x:number):number The function to plot
---@param from number
---@param to number
---@param n? integer Defaults to 200.
function Desmos.sample(name, f, from, to, n) end

---The type of a Desmos object.
---This is a strict superset of Lua's builtin `type`, and only returns different values for userdata.
---N.B. Actions, Desmos functions, and Lua functions all return "function". (todo: fix?)
---@see type
---@see math.type
---```lua
---Desmos.type(5)              --> "number"
---Desmos.type(Desmos.G)       --> "polygon"
---Desmos.type(Desmos.items[1])--> "item"
---```
---@param v any
---@return DesmosTypes type the type of the object.
function Desmos.type(v) end

---The sheet's items, name, line number, or id (with `byId()`).
---```lua
---Desmos.items.P.color = "#aabbcc"
---Desmos.items[1].hidden = true
---Desmos.items.byId("17").label = "hi"
---for i, item in pairs(Desmos.items) do print(i, item) end
---```
---@type DesmosItems
Desmos.items = nil

---The graph's settings and viewport.
---```lua
---Desmos.settings.showGrid = false
---Desmos.settings.viewport = { xmin = -5, xmax = 5 }
---```
---@type DesmosSettings
Desmos.settings = nil



---The ticker at the top of the expression sheet.
---@class DesmosTicker
---@field handlerLatex latex The action to run on every tick.
---@field minStepLatex expression The shortest gap between ticks, in milliseconds.
---@field playing boolean Setting this to true starts the ticker
---@field open boolean
---@type DesmosTicker
Desmos.ticker = nil

---Gets an item by Desmos ID instead of the line number
---Desmos IDs are stable between reordering expressions, creating new lines, and saving/loading the graph.
---N.B. You can enable Show IDs in DesModder -> Core -> Calculator Settings
---@param id string|integer
---@return DesmosItem? item or nil, if that ID does not exist.
function DesmosItems.byId(id) end
