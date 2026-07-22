// Scans a Docker image with Trivy and fails the build on High/Critical CVEs.
//
// call(Map params)
//   params.imageName (String, required)
//   params.tag       (String, required)
//   params.severity  (String, default 'HIGH,CRITICAL')
//   params.exitCode  (Integer, default 1)
def call(Map params) {
    def imageName = params.imageName
    def tag = params.tag
    def severity = params.severity ?: 'HIGH,CRITICAL'
    def exitCode = params.containsKey('exitCode') ? params.exitCode : 1

    def cmd = "trivy image --exit-code ${exitCode} --severity ${severity} ${imageName}:${tag}"
    if (isUnix()) {
        sh cmd
    } else {
        bat cmd
    }
}

return this
