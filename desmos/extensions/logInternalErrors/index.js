extension({
    id: "logInternalErrors",
    ready(Calc) {
        Calc._calc.graphSettings.config.logInternalErrors = true;
    }
});
