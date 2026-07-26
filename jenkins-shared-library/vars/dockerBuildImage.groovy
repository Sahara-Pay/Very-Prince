// Builds a Docker image from the given Dockerfile, tagged `<imageName>:<tag>`.
//
// call(Map params)
//   params.dockerfile (String, required) - e.g. 'packages/backend/Dockerfile'
//   params.imageName  (String, required)
//   params.tag        (String, required)
def call(Map params) {
    def dockerfile = params.dockerfile
    def imageName = params.imageName
    def tag = params.tag

    if (isUnix()) {
        sh "docker build --file ${dockerfile} --tag ${imageName}:${tag} ."
    } else {
        def windowsDockerfile = dockerfile.replace('/', '\\')
        bat "docker build --file ${windowsDockerfile} --tag ${imageName}:${tag} ."
    }
}

return this
