extension({
    id: "shapes",
    patches: [
        // enable geometry
        {
            match: /isGeometryCalculator:(?=\i\.evaluationMode===)/,
            replace: "isGeometryCalculator:!0||",
            count: 1
        },
        // add to quill config
        {
            match: /includeGeometryFunctions:(?=\i\.isGeometry\(\))/,
            replace: "includeGeometryFunctions:!0||",
            count: 1
        }
    ]
});
