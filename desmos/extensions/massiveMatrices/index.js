extension({
    id: "massiveMatrices",
    patches: [
        // max matrix size
        {
            match: /(\i.length)>32(\)throw)/,
            replace: "$1>100000000$2"
        },
        {
            match: /if\(\i\(\i,this\.model\.config\.maxResizingMatrixSize\)\)/,
            replace: "if(false)"
        },
        {
            match: /maxResizingMatrixSize:9/,
            replace: "maxResizingMatrixSize:100"
        },
        /*
        This is the matrix action check:
        function iq(e) {
        if (e.length > 9 || e[0].length > 9) throw i1(9);
        }
         */
        {
            match: /if\(\i\.length>9\|\|\i\[0]\.length>9\)/,
            replace: "if(false)"
        },
        // functions
        {
            match: /\i\.includes\(\i\)\|\|(?=\i\.restrictedFunctions)/g,
            replace: "",
            count: 1
        }
    ],
    ready(Calc) {
        const original = Calc.controller.getMathquillConfig;
        Calc.controller.getMathquillConfig = (e) => {
            const config = original.call(Calc.controller, e);
            config.autoOperatorNames +=
                " rowMatrix zeroMatrix hcat vcat matrixElement rowCount colCount submatrix";
            return config;
        };
    }
});
