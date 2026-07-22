// Build/deploy steps are abstracted into jenkins-shared-library/vars/*.groovy,
// loaded via load() until the library is extracted into its own repo and
// registered as a Jenkins Global Pipeline Library (see
// jenkins-shared-library/README.md).
def lib = [:]

pipeline {
    agent {
        label 'terraform'
    }

    environment {
        TF_VERSION            = '1.9.0'
        AWS_DEFAULT_REGION    = 'us-east-1'
        TERRAFORM_DIR         = 'terraform'
        REGISTRY              = 'ghcr.io/bridgetthnkechi87-cloud'
        BACKEND_IMAGE         = "${REGISTRY}/very-prince-backend"
        FRONTEND_IMAGE        = "${REGISTRY}/very-prince-frontend"
        // ─── BuildKit ──────────────────────────────────────────────────
        // Enable BuildKit for the legacy `docker build` command and export
        // it so the docker CLI default builder also picks it up. The
        // Dockerfiles use `--mount=type=cache` which requires BuildKit.
        DOCKER_BUILDKIT       = '1'
        // Registry cache refs shared across Jenkins agents. These are pushed
        // to the container registry so subsequent builds on any agent can
        // reuse the BuildKit layer cache.
        BUILDKIT_CACHE_REF_BACKEND  = "${REGISTRY}/very-prince-backend:buildcache"
        BUILDKIT_CACHE_REF_FRONTEND = "${REGISTRY}/very-prince-frontend:buildcache"
        // ─── Terraform state backend ────────────────────────────────────
        // These values must match terraform/backend.tf. Override per
        // environment if a different bucket or lock table is used.
        STATE_BUCKET_NAME     = 'very-prince-terraform-state'
        DYNAMODB_LOCK_TABLE   = 'very-prince-terraform-locks'
    }

    options {
        timestamps()
        timeout(time: 30, unit: 'MINUTES')
        ansiColor('xterm')
    }

    stages {
        stage('Setup') {
            steps {
                script {
                    lib.tfSetup             = load('jenkins-shared-library/vars/tfSetup.groovy')
                    lib.tfInit              = load('jenkins-shared-library/vars/tfInit.groovy')
                    lib.tfVerifyBackendLock = load('jenkins-shared-library/vars/tfVerifyBackendLock.groovy')
                    lib.tfValidate          = load('jenkins-shared-library/vars/tfValidate.groovy')
                    lib.tfPlan              = load('jenkins-shared-library/vars/tfPlan.groovy')
                    lib.tfApply             = load('jenkins-shared-library/vars/tfApply.groovy')
                    lib.dockerBuildImage    = load('jenkins-shared-library/vars/dockerBuildImage.groovy')
                    lib.trivyScanImage      = load('jenkins-shared-library/vars/trivyScanImage.groovy')

                    lib.tfSetup(tools: ['terraform', 'aws', 'docker', 'trivy'])
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    lib.dockerBuildImage(
                        dockerfile: 'packages/backend/Dockerfile',
                        imageName: env.DOCKER_IMAGE,
                        tag: env.BUILD_NUMBER
                    )
        stage('Build & Push Images') {
            // Run backend and frontend builds in parallel to reduce wall time.
            // Each branch uses the platform-appropriate shell (sh vs bat).
            parallel {
                stage('Backend') {
                    steps {
                        script {
                            if (isUnix()) {
                                sh '''
                                    set -euo pipefail
                                    docker buildx build \
                                      --file packages/backend/Dockerfile \
                                      --tag ${BACKEND_IMAGE}:${BUILD_NUMBER} \
                                      --tag ${BACKEND_IMAGE}:latest \
                                      --cache-from=type=registry,ref=${BUILDKIT_CACHE_REF_BACKEND} \
                                      --cache-to=type=registry,ref=${BUILDKIT_CACHE_REF_BACKEND},mode=max \
                                      --push \
                                      .
                                '''
                            } else {
                                bat '''
                                    docker buildx build ^
                                      --file packages\\backend\\Dockerfile ^
                                      --tag %BACKEND_IMAGE%:%BUILD_NUMBER% ^
                                      --tag %BACKEND_IMAGE%:latest ^
                                      --cache-from=type=registry,ref=%BUILDKIT_CACHE_REF_BACKEND% ^
                                      --cache-to=type=registry,ref=%BUILDKIT_CACHE_REF_BACKEND%,mode=max ^
                                      --push ^
                                      .
                                '''
                            }
                        }
                    }
                }

                stage('Frontend') {
                    steps {
                        script {
                            if (isUnix()) {
                                sh '''
                                    set -euo pipefail
                                    docker buildx build \
                                      --file packages/frontend/Dockerfile \
                                      --tag ${FRONTEND_IMAGE}:${BUILD_NUMBER} \
                                      --tag ${FRONTEND_IMAGE}:latest \
                                      --cache-from=type=registry,ref=${BUILDKIT_CACHE_REF_FRONTEND} \
                                      --cache-to=type=registry,ref=${BUILDKIT_CACHE_REF_FRONTEND},mode=max \
                                      --push \
                                      .
                                '''
                            } else {
                                bat '''
                                    docker buildx build ^
                                      --file packages\\frontend\\Dockerfile ^
                                      --tag %FRONTEND_IMAGE%:%BUILD_NUMBER% ^
                                      --tag %FRONTEND_IMAGE%:latest ^
                                      --cache-from=type=registry,ref=%BUILDKIT_CACHE_REF_FRONTEND% ^
                                      --cache-to=type=registry,ref=%BUILDKIT_CACHE_REF_FRONTEND%,mode=max ^
                                      --push ^
                                      .
                                '''
                            }
                        }
                    }
                }
            }
        }

        stage('Scan Backend Image') {
            // Security gate: scan the backend image for HIGH/CRITICAL CVEs.
            // The frontend is not scanned here; add a parallel stage if needed.
            steps {
                script {
                    lib.trivyScanImage(
                        imageName: env.DOCKER_IMAGE,
                        tag: env.BUILD_NUMBER
                    )
                    if (isUnix()) {
                        sh '''
                            trivy image --exit-code 1 --severity HIGH,CRITICAL ${BACKEND_IMAGE}:${BUILD_NUMBER}
                        '''
                    } else {
                        bat '''
                            trivy image --exit-code 1 --severity HIGH,CRITICAL %BACKEND_IMAGE%:%BUILD_NUMBER%
                        '''
                    }
                }
            }
        }

        stage('Init') {
            steps {
                script {
                    lib.tfInit(
                        dir: env.TERRAFORM_DIR,
                        backendConfig: [
                            bucket: env.STATE_BUCKET_NAME,
                            dynamodb_table: env.DYNAMODB_LOCK_TABLE,
                            region: env.AWS_DEFAULT_REGION,
                            encrypt: 'true'
                        ]
                    )
                }
            }
        }

        stage('Verify Backend Lock') {
            steps {
                script {
                    lib.tfVerifyBackendLock(dir: env.TERRAFORM_DIR)
                }
            }
        }

        stage('Validate') {
            steps {
                script {
                    lib.tfValidate(dir: env.TERRAFORM_DIR)
                }
            }
        }

        stage('Plan') {
            steps {
                script {
                    lib.tfPlan(
                        dir: env.TERRAFORM_DIR,
                        planFile: 'tfplan',
                        stashName: 'tfplan',
                        lockTimeout: '300s'
                    )
                }
            }
        }

        stage('Apply') {
            when {
                branch 'main'
            }
            input {
                message 'Apply Terraform plan to production?'
                ok 'Apply'
                submitterParameter 'APPROVER'
            }
            steps {
                script {
                    lib.tfApply(
                        dir: env.TERRAFORM_DIR,
                        planFile: 'tfplan',
                        stashName: 'tfplan',
                        lockTimeout: '300s'
                    )
                }
            }
        }
    }

    post {
        // Preserve the workspace between runs so the local BuildKit layer
        // cache (and Terraform provider plugins) survive. This is the
        // primary mechanism that keeps `npm ci` cache mounts warm across
        // Jenkins agent runs alongside the registry cache in
        // BUILDKIT_CACHE_REF_BACKEND / BUILDKIT_CACHE_REF_FRONTEND.
        success {
            echo 'Pipeline completed successfully'
        }
        failure {
            // Only wipe the workspace on failure to free disk space; a
            // successful run keeps the workspace intact so the next run
            // can reuse the BuildKit layer cache.
            cleanWs()
            echo 'Pipeline failed'
        }
    }
}
