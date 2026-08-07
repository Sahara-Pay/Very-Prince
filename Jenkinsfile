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
        // The Dockerfiles consume these verbatim in `turbo run build`.
        // `...` includes each deployable package's workspace dependencies.
        // Defaults are used when the changeset-detection step falls back to
        // a full build (e.g. first run, no merge base, infra-only changes).
        BACKEND_TURBO_FILTER  = '--filter=@very-prince/backend...'
        FRONTEND_TURBO_FILTER = '--filter=@very-prince/frontend...'
        // Workspace package names whose Dockerfiles should be considered
        // deployable images. The changeset-detection step maps changed
        // package paths to this set so the pipeline only builds Docker
        // images for packages that actually changed.
        DEPLOYABLE_PACKAGES   = 'backend,frontend'
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
                    lib.crossPlatformSh     = load('jenkins-shared-library/vars/crossPlatformSh.groovy')
                    lib.dockerBuildImage     = load('jenkins-shared-library/vars/dockerBuildImage.groovy')
                    lib.tfSetup             = load('jenkins-shared-library/vars/tfSetup.groovy')
                    lib.tfInit              = load('jenkins-shared-library/vars/tfInit.groovy')
                    lib.tfVerifyBackendLock = load('jenkins-shared-library/vars/tfVerifyBackendLock.groovy')
                    lib.tfValidate          = load('jenkins-shared-library/vars/tfValidate.groovy')
                    lib.tfPlan              = load('jenkins-shared-library/vars/tfPlan.groovy')
                    lib.tfApply             = load('jenkins-shared-library/vars/tfApply.groovy')
                    lib.tfSetup(tools: ['terraform', 'aws', 'docker', 'trivy', 'turbo'])
                }
            }
        }

        stage('Detect Changed Packages') {
            // Determine which deployable packages have changed vs the merge
            // base (or origin/main if no merge base). We map changed file
            // paths to workspace package names by prefix, then intersect
            // with DEPLOYABLE_PACKAGES. Only those packages get Docker
            // images built.
            //
            // The diff itself is run cross-platform via `crossPlatformSh`;
            // the per-line parsing into package names happens in Groovy so
            // the same code path runs on Unix and Windows.
            steps {
                script {
                    // Get the merge base as a short SHA
                    def mergeBase = ''
                    if (isUnix()) {
                        mergeBase = sh(
                            script: 'git merge-base HEAD origin/main 2>/dev/null || git rev-parse origin/main',
                            returnStdout: true
                        ).trim()
                    } else {
                        mergeBase = bat(
                            script: '@echo off && for /f "delims=" %%i in (\'git merge-base HEAD origin/main 2^>nul\') do @echo %%i || for /f "delims=" %%i in (\'git rev-parse origin/main\') do @echo %%i',
                            returnStdout: true
                        ).trim()
                    }
                    // List changed file paths relative to the merge base
                    def changedFiles = ''
                    if (isUnix()) {
                        changedFiles = sh(
                            script: "git diff --name-only ${mergeBase} 2>/dev/null || true",
                            returnStdout: true
                        ).trim()
                    } else {
                        changedFiles = bat(
                            script: "@echo off && git diff --name-only ${mergeBase} 2>nul",
                            returnStdout: true
                        ).trim()
                    }
                    // Parse in Groovy: extract unique `packages/<name>/...` segments
                    def pkgSet = [] as Set
                    changedFiles.split('\n').each { line ->
                        def trimmed = line.replace('\\', '/').trim()
                        if (trimmed.startsWith('packages/')) {
                            def parts = trimmed.split('/')
                            if (parts.length >= 2) {
                                pkgSet << parts[1]
                            }
                        }
                    }
                    def changedPackages = pkgSet.sort().join('\n')
                    env.CHANGED_PACKAGES = changedPackages
                    echo "Changed packages: ${changedPackages}"
                }
            }
        }

        stage('Build & Push Images') {
            // Build Docker images only for deployable packages that changed.
            // Uses dynamic parallel branches keyed by package name.
            //
            // Cross-platform: uses `crossPlatformSh` (from the shared library)
            // for consistent sh/bat dispatch. On Windows, `docker buildx`
            // is available natively (no WSL).
            steps {
                script {
                    def deployable = env.DEPLOYABLE_PACKAGES.split(',').collect { it.trim() }
                    def changed = env.CHANGED_PACKAGES.split('\n').collect { it.trim() }.findAll { it }
                    def toBuild = deployable.intersect(changed)
                    
                    if (!toBuild) {
                        echo 'No deployable packages changed; skipping Docker builds'
                        env.SKIP_DOCKER_BUILD = 'true'
                        return
                    }
                    
                    def parallelStages = [:]
                    toBuild.each { pkg ->
                        parallelStages["${pkg}"] = {
                            def dockerfile = "packages/${pkg}/Dockerfile"
                            def image = (pkg == 'backend') ? env.BACKEND_IMAGE : env.FRONTEND_IMAGE
                            def turboFilter = (pkg == 'backend') ? env.BACKEND_TURBO_FILTER : env.FRONTEND_TURBO_FILTER
                            def cacheRef = (pkg == 'backend') ? env.BUILDKIT_CACHE_REF_BACKEND : env.BUILDKIT_CACHE_REF_FRONTEND
                            def tag = env.BUILD_NUMBER

                            // Use crossPlatformSh for consistent sh/bat dispatch
                            lib.crossPlatformSh(
                                sh: '''
                                    set -euo pipefail
                                    docker buildx build \
                                      --file ''' + dockerfile + ''' \
                                      --build-arg TURBO_FILTER="''' + turboFilter + '"' + ''' \
                                      --tag ''' + image + ':' + tag + ''' \
                                      --tag ''' + image + ':latest' + ''' \
                                      --cache-from=type=registry,ref=''' + cacheRef + ''' \
                                      --cache-to=type=registry,ref=''' + cacheRef + ''',mode=max \
                                      --push \
                                      .
                                ''',
                                bat: '''
                                    docker buildx build ^
                                      --file ''' + dockerfile.replace('/', '\\') + ''' ^
                                      --build-arg TURBO_FILTER="''' + turboFilter + '"' + ''' ^
                                      --tag ''' + image + ':%BUILD_NUMBER%' + ''' ^
                                      --tag ''' + image + ':latest' + ''' ^
                                      --cache-from=type=registry,ref=''' + cacheRef + ''' ^
                                      --cache-to=type=registry,ref=''' + cacheRef + ''',mode=max ^
                                      --push ^
                                      .
                                '''
                            )
                        }
                    }
                    parallel parallelStages
                }
            }
        }

        stage('Scan Backend Image') {
            // Security gate: scan the backend image for HIGH/CRITICAL CVEs.
            // Only runs if the backend image was actually built.
            when {
                expression { env.SKIP_DOCKER_BUILD != 'true' && env.CHANGED_PACKAGES.contains('backend') }
            }
            steps {
                script {
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
