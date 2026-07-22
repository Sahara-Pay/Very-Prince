// Runs `terraform fmt -check -recursive` in the given directory.
//
// call(Map params)
//   params.dir (String, required)
def call(Map params) {
    dir(params.dir) {
        if (isUnix()) {
            sh 'terraform fmt -check -recursive'
        } else {
            bat 'terraform.exe fmt -check -recursive'
        }
    }
}

return this
