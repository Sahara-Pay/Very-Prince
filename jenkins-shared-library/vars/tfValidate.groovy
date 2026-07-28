// Runs `terraform validate` in the given directory. When `standalone` is true, first
// runs a backend-less `terraform init` so a module directory can be validated on its
// own, independent of the root backend configuration.
//
// call(Map params)
//   params.dir        (String, required)
//   params.standalone (boolean, default false)
def call(Map params) {
    def dirPath = params.dir
    def standalone = params.standalone ?: false

    dir(dirPath) {
        if (standalone) {
            if (isUnix()) {
                sh 'terraform init -backend=false -input=false'
                sh 'terraform validate'
            } else {
                bat 'terraform.exe init -backend=false -input=false'
                bat 'terraform.exe validate'
            }
        } else {
            if (isUnix()) {
                sh 'terraform validate'
            } else {
                bat 'terraform.exe validate'
            }
        }
    }
}

return this
