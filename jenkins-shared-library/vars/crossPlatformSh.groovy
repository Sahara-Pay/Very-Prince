// Runs params.sh via `sh` on Unix agents, or params.bat (or params.sh if params.bat
// is not given) via `bat` on Windows agents.
//
// call(Map params)
//   params.sh           (String, required)  - command to run via `sh` on Unix
//   params.bat          (String, optional)  - command to run via `bat` on Windows; defaults to params.sh
//   params.returnStdout (boolean, default false)
//   params.returnStatus (boolean, default false)
def call(Map params) {
    def unixScript = params.sh
    def windowsScript = params.bat ?: params.sh
    def returnStdout = params.returnStdout ?: false
    def returnStatus = params.returnStatus ?: false

    if (isUnix()) {
        return sh(script: unixScript, returnStdout: returnStdout, returnStatus: returnStatus)
    }
    return bat(script: windowsScript, returnStdout: returnStdout, returnStatus: returnStatus)
}

// Executed only when loaded via the `load()` step (see jenkins-shared-library/README.md);
// a no-op when used as a registered shared-library global variable.
return this
