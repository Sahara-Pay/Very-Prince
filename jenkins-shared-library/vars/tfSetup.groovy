// Prints version info for the CLIs a pipeline depends on, so a missing/misconfigured
// agent fails fast in the Setup stage instead of partway through a build.
//
// call(Map params)
//   params.tools (List<String>, default ['terraform']) - subset of ['terraform', 'aws', 'docker', 'trivy']
def call(Map params) {
    def tools = params.tools ?: ['terraform']
    def catalog = [
        terraform: [sh: 'terraform -version', bat: 'terraform.exe -version'],
        aws      : [sh: 'aws --version', bat: 'aws --version'],
        docker   : [sh: 'docker --version', bat: 'docker --version'],
        // turbo ships as a local devDependency in package.json; `npx turbo`
        // resolves it through the workspace on both Unix and Windows.
        // On Windows `bat` runs in cmd.exe, where `npx` resolves the
        // `turbo.cmd` shim from node_modules/.bin transparently.
        turbo    : [sh: 'npx turbo --version', bat: 'npx turbo --version'],
        trivy    : [sh: 'trivy --version', bat: 'trivy --version'],
    ]

    tools.each { toolName ->
        def cmds = catalog[toolName]
        if (!cmds) {
            error("tfSetup: unknown tool '${toolName}'. Supported tools: ${catalog.keySet().join(', ')}")
        }
        if (isUnix()) {
            sh cmds.sh
        } else {
            bat cmds.bat
        }
    }
}

return this
