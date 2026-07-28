// Unstashes a plan file and runs `terraform apply` against it in the given directory.
//
// call(Map params)
//   params.dir         (String, required)
//   params.planFile    (String, required)
//   params.stashName   (String, required)
//   params.lockTimeout (String, optional)  - e.g. '300s'; when set, adds -lock=true -lock-timeout=<v>
//   params.autoApprove (boolean, default true)
//   params.inputFalse  (boolean, default false)
def call(Map params) {
    def dirPath = params.dir
    def planFile = params.planFile
    def stashName = params.stashName
    def lockTimeout = params.lockTimeout
    def autoApprove = params.containsKey('autoApprove') ? params.autoApprove : true
    def inputFalse = params.inputFalse ?: false

    unstash stashName

    dir(dirPath) {
        def flags = []
        if (inputFalse) {
            flags << '-input=false'
        }
        if (lockTimeout) {
            flags << '-lock=true'
            flags << "-lock-timeout=${lockTimeout}"
        }
        if (autoApprove) {
            flags << '-auto-approve'
        }
        def flagsStr = flags.join(' ')

        if (isUnix()) {
            sh "terraform apply ${flagsStr} ${planFile}"
        } else {
            bat "terraform.exe apply ${flagsStr} ${planFile}"
        }
    }
}

return this
