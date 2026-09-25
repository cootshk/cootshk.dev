extension({
    id: "noRecursionLimit",
    patches: [
        // error message
        {
            match: /(shared-calculator-error-recursion-depth-limit-exceeded = )[a-zA-Z._${} \-]+\n?/,
            replace:
                "$1This function likely recurses indefinitely. Alternatively, try optimizing it.\n",
            count: 1
        },
        // recursive depth limit
        {
            match: /(\i\.defaultLimit=1e5;var \i=\i,\i)=1e4/,
            replace: "$1=1e8",
            count: 1
        },
        // nested too deeply
        {
            match: "if(this.instructions.length>=32768)",
            replace: "if(false)",
            count: 1
        }
    ]
});
