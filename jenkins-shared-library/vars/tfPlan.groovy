// Runs `terraform plan -out=<planFile>` in the given directory and stashes the plan
// file under the given name for a later Apply stage to unstash.
//
// call(Map params)
//   params.dir         (String, required)
//   params.planFile    (String, required)
//   params.stashName   (String, required)
//   params.target      (String, optional)  - e.g. 'module.rds_snapshot_lifecycle'
//   params.lockTimeout (String, optional)  - e.g. '300s'; when set, adds -lock=true -lock-timeout=<v>
//   params.inputFalse  (boolean, default false)
def call(Map params) {
    def dirPath = params.dir
    def planFile = params.planFile
    def stashName = params.stashName
    def target = params.target
    def lockTimeout = params.lockTimeout
    def inputFalse = params.inputFalse ?: false

    dir(dirPath) {
        def flags = []
        if (inputFalse) {
            flags << '-input=false'
        }
        if (lockTimeout) {
            flags << '-lock=true'
            flags << "-lock-timeout=${lockTimeout}"
        }
        if (target) {
            flags << "-target=${target}"
        }
        flags << "-out=${planFile}"
        def flagsStr = flags.join(' ')

        if (isUnix()) {
            sh "terraform plan ${flagsStr}"
        } else {
            bat "terraform.exe plan ${flagsStr}"
        }

        stash includes: "${dirPath}/${planFile}", name: stashName
    }
}

return this
