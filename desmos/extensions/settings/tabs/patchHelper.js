// The Patch Helper tab: a match box, a replace box, and a diff of what the patch they spell
// out would do to the Desmos bundle. It is a tool for writing extensions rather than one for
// using the calculator, so the tab is only there when the extension by that name is on.
//
// The pattern is compiled with the loader's own `canonicalizeMatch` and `$self` expanded with
// its `expandSelf` (both extensions.js, both in scope here); `BUILD_SCRIPT` is desmos.js'. The
// real ones on purpose: a preview built out of a second implementation of `\i` is a preview of
// the wrong thing.
//
// A tab of the settings extension; ../index.js owns the registry this hands itself to, and
// the patches that give the tab somewhere to be.
(function () {
    Extensions.settings.tab({
        key: "patch-helper",
        label: "Patch Helper",
        render: patchHelperTab,
        when: function () {
            return !!Extensions.patchHelper;
        }
    });

    // A patch is a regex against several megabytes of minified JavaScript, and a line diff of
    // that is one line. So what is shown is the neighbourhood of each match: the same run of
    // bundle before and after the replacement, with this much either side of it.
    var CONTEXT = 90;
    // Matches shown, and the point at which counting stops. A pattern with more matches than
    // the first of these is too loose to be a patch, and one with more than the second is not
    // worth finishing the count of.
    var SHOWN = 25;
    var CEILING = 10000;
    // The most words a match and its replacement may make a diff table out of.
    var CELLS = 250000;

    // The bundle Desmos would have run, fetched the first time this tab is opened and kept
    // for the rest of the load. Not the copy the extensions patched: a patch is written
    // against the build as it ships, which is also what applyPatches hands the first patch.
    var source = null;

    /**
     * That bundle's text. Its <script> is still in the document - the loader only changed the
     * tag's type to hold it back - and __desmosExt.fetch is the unpatched fetch, so this goes
     * to the proxy rather than to the blob the patched copy lives in.
     */
    function loadSource() {
        if (source) return source;
        var script = Array.prototype.filter.call(
            document.querySelectorAll("script[src]"),
            function (one) {
                return BUILD_SCRIPT.test(one.getAttribute("src"));
            }
        )[0];
        source = script
            ? window.__desmosExt.fetch(script.src).then(function (res) {
                  if (!res.ok)
                      throw new Error(res.status + " " + res.statusText);
                  return res.text();
              })
            : Promise.reject(new Error("no build script in this page"));
        return source;
    }

    /**
     * The match field as a patch would take it. With "Regex" on that is a regex, written
     * `/.../flags` if it wants flags of its own; with it off it is the text itself, which is
     * what a `match` written as a plain string is. canonicalizeMatch is the loader's own, so
     * `\i` and the implied /g mean here exactly what they mean there.
     */
    function compile(text, asRegex) {
        if (!asRegex) return text;
        var flags = "";
        var end = text.lastIndexOf("/");
        if (text.charAt(0) === "/" && end > 0) {
            flags = text.slice(end + 1);
            text = text.slice(1, end);
        }
        return canonicalizeMatch(new RegExp(text, flags));
    }

    /**
     * The pattern as it is shown above the diff: a regex as itself, a string quoted - which
     * is the only way a stray space or newline in the match box gives itself away.
     */
    function show(match) {
        return typeof match === "string"
            ? JSON.stringify(match)
            : String(match);
    }

    /**
     * Where `match` is found in `text`: the first SHOWN of them, and how many there are in
     * all. For a string those two numbers disagree on purpose - applyPatches replaces it with
     * String.replace, which takes only the first, but checks `count` against every one.
     */
    function findAll(text, match) {
        if (typeof match === "string") {
            var at = text.indexOf(match);
            // Shaped like a regex match, so that the diff below need not care which it has.
            var first = [match];
            first.index = at;
            return {
                found: at === -1 ? [] : [first],
                count: countMatches(text, match)
            };
        }
        var all = new RegExp(match.source, match.flags.replace("g", "") + "g");
        var found = [];
        var count = 0;
        var hit;
        while ((hit = all.exec(text)) !== null) {
            count++;
            if (found.length < SHOWN) found.push(hit);
            // A pattern that can match nothing would sit on the same index forever.
            if (hit[0] === "") all.lastIndex++;
            if (count >= CEILING) break;
        }
        return { found: found, count: count };
    }

    /** The status line: how many there are, and how many of them a patch would take. */
    function summary(match, hits) {
        if (typeof match === "string")
            return hits.count === 1
                ? "1 occurrence."
                : hits.count +
                      " occurrences, but a plain string is replaced only where it first " +
                      "appears. count still asserts all " +
                      hits.count +
                      ".";
        return (
            (hits.count >= CEILING ? "Over " + CEILING : hits.count) +
            (hits.count === 1 ? " match" : " matches") +
            (hits.count > hits.found.length
                ? ", showing the first " + hits.found.length
                : "") +
            "."
        );
    }

    /**
     * What String.replace would put in for one match - $&, $1, $<name> and the rest - done
     * here rather than by running the replace, so that each match can be previewed on its own
     * without building a second copy of the bundle.
     */
    function substitute(replacement, match, text) {
        var end = match.index + match[0].length;
        return replacement.replace(
            /\$([$&`']|<([^>]*)>|\d{1,2})/g,
            function (token, what, name) {
                if (what === "$") return "$";
                if (what === "&") return match[0];
                if (what === "`") return text.slice(0, match.index);
                if (what === "'") return text.slice(end);
                if (name !== undefined)
                    return (match.groups && match.groups[name]) || "";
                var group = parseInt(what, 10);
                if (group >= 1 && group < match.length)
                    return match[group] === undefined ? "" : match[group];
                // "$12" with only three groups is group 1 followed by a literal 2.
                group = parseInt(what.charAt(0), 10);
                if (what.length === 2 && group >= 1 && group < match.length)
                    return (
                        (match[group] === undefined ? "" : match[group]) +
                        what.charAt(1)
                    );
                return token;
            }
        );
    }

    /** One run of bundle on one line, so that a match's context stays beside it. */
    function flatten(text) {
        return text.replace(/\r/g, "").replace(/\n/g, "⏎").replace(/\t/g, "⇥");
    }

    /** Add to a run list, growing the last run rather than starting one of the same kind. */
    function push(runs, kind, text) {
        if (!text) return;
        var last = runs[runs.length - 1];
        if (last && last.kind === kind) last.text += text;
        else runs.push({ kind: kind, text: text });
    }

    /**
     * `text` as the units a diff is taken in: whole identifiers and numbers, whole runs of
     * whitespace, and everything else one character at a time. By word rather than by
     * character because two unrelated minified names share enough letters that a character
     * diff reads as a dozen tiny edits where there was one - `location.hash` against `this.x`
     * comes out as five, none of which mean anything.
     */
    function words(text) {
        return text.match(/[\w$]+|\s+|[\s\S]/g) || [];
    }

    /**
     * The middle of a diff - what is left of two word lists once their ends agree - as del
     * and ins runs around the longest run of words they have in common. The table is why
     * CELLS exists: it is one Int32 per pair of words, so a replacement the length of a
     * paragraph is fine and one the length of a file is not, and that falls back to painting
     * each side whole.
     */
    function align(runs, before, after) {
        if (
            !before.length ||
            !after.length ||
            before.length * after.length > CELLS
        ) {
            push(runs, "del", before.join(""));
            push(runs, "ins", after.join(""));
            return;
        }
        var width = after.length + 1;
        var common = new Int32Array((before.length + 1) * width);
        for (var i = before.length - 1; i >= 0; i--) {
            for (var j = after.length - 1; j >= 0; j--) {
                common[i * width + j] =
                    before[i] === after[j]
                        ? common[(i + 1) * width + j + 1] + 1
                        : Math.max(
                              common[(i + 1) * width + j],
                              common[i * width + j + 1]
                          );
            }
        }
        var x = 0;
        var y = 0;
        while (x < before.length && y < after.length) {
            if (before[x] === after[y]) {
                push(runs, "", before[x]);
                x++;
                y++;
            } else if (
                common[(x + 1) * width + y] >= common[x * width + y + 1]
            ) {
                push(runs, "del", before[x]);
                x++;
            } else {
                push(runs, "ins", after[y]);
                y++;
            }
        }
        push(runs, "del", before.slice(x).join(""));
        push(runs, "ins", after.slice(y).join(""));
    }

    /**
     * `before` becoming `after`, as runs of unchanged text ("") and text the patch takes out
     * ("del") or puts in ("ins"). Both sides on one line rather than two: a replacement
     * usually carries most of the match inside it - anything built on `$&` does - and a diff
     * that paints the whole of both hides the few words that actually differ.
     */
    function inline(before, after) {
        var a = words(before);
        var b = words(after);
        // The ends nearly always agree. Taking them off first is what keeps the table small
        // enough to be worth building at all.
        var shortest = Math.min(a.length, b.length);
        var head = 0;
        while (head < shortest && a[head] === b[head]) head++;
        var tail = 0;
        while (
            tail < shortest - head &&
            a[a.length - 1 - tail] === b[b.length - 1 - tail]
        )
            tail++;

        var runs = [];
        push(runs, "", a.slice(0, head).join(""));
        align(
            runs,
            a.slice(head, a.length - tail),
            b.slice(head, b.length - tail)
        );
        push(runs, "", a.slice(a.length - tail).join(""));
        return runs;
    }

    function patchHelperTab(root) {
        var ui = window.__desmosExt.ui;
        var bundle = null;
        var timer = null;

        var match = box("\\i\\.restrictedFunctions");
        // On, because a patch is nearly always a regex - and because a literal is the one
        // case where what you typed is what is searched for, which needs no explaining.
        var regex = ui.el("input", {
            type: "checkbox",
            checked: true,
            onchange: update
        });
        var replace = box("$self.hook($&)");
        var status = ui.el("p", {
            class: "cde-patch__status",
            text: "Reading the Desmos bundle…"
        });
        // A <pre> rather than a textarea: the whole point is that the characters a patch
        // takes out and puts in are coloured differently, and a textarea holds only text.
        var diff = ui.el("pre", {
            class: "cde-patch__diff",
            tabindex: "0",
            "aria-label": "Diff"
        });

        ui.el(
            root,
            null,
            titled("label", "Match", match),
            ui.el("label", { class: "cde-patch__option" }, regex, "Regex"),
            titled("label", "Replace", replace),
            status,
            titled("div", "Diff", diff, true)
        );

        loadSource().then(
            function (text) {
                bundle = text;
                update();
            },
            function (error) {
                say("Couldn't read the Desmos bundle: " + error.message, true);
            }
        );

        return function () {
            clearTimeout(timer);
        };

        /** A field. Its placeholder is an example of what goes in it. */
        function box(placeholder) {
            return ui.el("textarea", {
                class: "cde-patch__field",
                rows: "2",
                spellcheck: "false",
                placeholder: placeholder,
                oninput: schedule
            });
        }

        /**
         * Something under a heading of its own. A `label` wraps its field, so the heading
         * names it to a screen reader and focuses it when tapped; the diff is not a field, so
         * it gets a plain div and carries its own aria-label.
         */
        function titled(tag, title, node, grow) {
            return ui.el(
                tag,
                {
                    class:
                        "cde-patch__group" +
                        (grow ? " cde-patch__group--grow" : "")
                },
                ui.el("span", { class: "cde-patch__title", text: title }),
                node
            );
        }

        function schedule() {
            clearTimeout(timer);
            timer = setTimeout(update, 150);
        }

        function say(text, bad) {
            status.textContent = text;
            status.hidden = !text;
            status.className =
                "cde-patch__status" + (bad ? " cde-patch__status--error" : "");
        }

        function update() {
            if (bundle === null) return;
            diff.textContent = "";

            // Only a regex is trimmed: whitespace at either end of a plain string is part of
            // the text to find.
            var pattern = regex.checked ? match.value.trim() : match.value;
            if (!pattern) {
                say("");
                return;
            }

            var wanted;
            try {
                wanted = compile(pattern, regex.checked);
            } catch (error) {
                say("Not a regex: " + error.message, true);
                return;
            }

            var hits = findAll(bundle, wanted);
            if (!hits.count) {
                say(
                    "No matches. A patch that matches nothing throws, and takes its " +
                        "extension out of the load with it.",
                    true
                );
                diff.appendChild(patternLine(wanted));
                return;
            }
            say(summary(wanted, hits));

            // $self is expanded the way applyPatches expands it, but with nothing to put in
            // for the id: which extension this patch will belong to is not something the
            // helper can know.
            var replacement = expandSelf(replace.value, "‹your extension›");

            diff.appendChild(patternLine(wanted));
            hits.found.forEach(function (one) {
                diff.appendChild(
                    ui.el("div", {
                        class: "cde-patch__at",
                        text: "@ " + one.index
                    })
                );
                diff.appendChild(hunk(one, replacement));
            });
        }

        function patternLine(wanted) {
            return ui.el("div", {
                class: "cde-patch__pattern",
                text: show(wanted)
            });
        }

        /** One match, with the bundle either side of it and the change coloured in place. */
        function hunk(one, replacement) {
            var end = one.index + one[0].length;
            return ui.el(
                "div",
                { class: "cde-patch__line" },
                (one.index > CONTEXT ? "…" : "") +
                    flatten(
                        bundle.slice(
                            Math.max(0, one.index - CONTEXT),
                            one.index
                        )
                    ),
                inline(one[0], substitute(replacement, one, bundle)).map(
                    function (run) {
                        return run.kind
                            ? ui.el("span", {
                                  class: "cde-patch__" + run.kind,
                                  text: flatten(run.text)
                              })
                            : flatten(run.text);
                    }
                ),
                flatten(bundle.slice(end, end + CONTEXT)) +
                    (end + CONTEXT < bundle.length ? "…" : "")
            );
        }
    }
})();
