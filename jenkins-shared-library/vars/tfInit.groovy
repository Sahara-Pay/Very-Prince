// Runs `terraform init` in the given directory, optionally with S3/DynamoDB
// backend-config flags.
//
// call(Map params)
//   params.dir           (String, required)
//   params.backendConfig (Map<String,String>, optional) - e.g. [bucket: ..., dynamodb_table: ..., region: ..., encrypt: 'true']
//   params.inputFalse    (boolean, default true)
def call(Map params) {
    def dirPath = params.dir
    def backendConfig = params.backendConfig ?: [:]
    def inputFalse = params.containsKey('inputFalse') ? params.inputFalse : true

    dir(dirPath) {
        def flags = []
        if (inputFalse) {
            flags << '-input=false'
        }
        backendConfig.each { key, value ->
            flags << "-backend-config=\"${key}=${value}\""
        }
        def flagsStr = flags.join(' ')

        if (isUnix()) {
            sh "terraform init ${flagsStr}"
        } else {
            bat "terraform.exe init ${flagsStr}"
        }
    }
}

return this
