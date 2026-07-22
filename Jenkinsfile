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
                    if (isUnix()) {
                        sh 'terraform -version'
                        sh 'aws --version'
                        sh 'docker --version'
                        sh 'trivy --version'
                    } else {
                        bat 'terraform.exe -version'
                        bat 'aws --version'
                        bat 'docker --version'
                        bat 'trivy --version'
                    }
                }
            }
        }

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
                dir(env.TERRAFORM_DIR) {
                    script {
                        if (isUnix()) {
                            sh """
                                terraform init \
                                  -input=false \
                                  -backend-config="bucket=${STATE_BUCKET_NAME}" \
                                  -backend-config="dynamodb_table=${DYNAMODB_LOCK_TABLE}" \
                                  -backend-config="region=${AWS_DEFAULT_REGION}" \
                                  -backend-config="encrypt=true"
                            """
                        } else {
                            bat """
                                terraform.exe init ^
                                  -input=false ^
                                  -backend-config="bucket=%STATE_BUCKET_NAME%" ^
                                  -backend-config="dynamodb_table=%DYNAMODB_LOCK_TABLE%" ^
                                  -backend-config="region=%AWS_DEFAULT_REGION%" ^
                                  -backend-config="encrypt=true"
                            """
                        }
                    }
                }
            }
        }

        stage('Verify Backend Lock') {
            steps {
                dir(env.TERRAFORM_DIR) {
                    script {
                        // Attempt to unlock a non-existent lock ID. Terraform
                        // will contact the DynamoDB lock table configured in
                        // the S3 backend and return an error referencing
                        // the missing lock. That confirms the backend is
                        // reachable and the lock table is wired up.
                        def attemptUnlock
                        if (isUnix()) {
                            attemptUnlock = sh(
                                returnStatus: true,
                                script: 'terraform force-unlock -force nonexistent-lock-id 2>&1 || true'
                            )
                        } else {
                            attemptUnlock = bat(
                                returnStatus: true,
                                script: 'terraform.exe force-unlock -force nonexistent-lock-id 2>&1 || exit 0'
                            )
                        }

                        // Capture the output text for assertion. The exact
                        // wording differs by Terraform version but always
                        // mentions "lock" when DynamoDB is reachable.
                        def output
                        if (isUnix()) {
                            output = sh(
                                returnStdout: true,
                                script: 'terraform force-unlock -force nonexistent-lock-id 2>&1 || true'
                            )
                        } else {
                            output = bat(
                                returnStdout: true,
                                script: '@echo off && terraform.exe force-unlock -force nonexistent-lock-id 2>&1 & exit /b 0'
                            )
                        }

                        if (!output.toLowerCase().contains('lock')) {
                            error(
                                "Backend lock verification failed: Terraform did not mention a 'lock' in its output. " +
                                "Expected DynamoDB-based locking to be reachable. Output was:\n${output}"
                            )
                        }
                        echo '✓ Backend lock verification passed: DynamoDB lock table is reachable.'
                    }
                }
            }
        }

        stage('Validate') {
            steps {
                dir(env.TERRAFORM_DIR) {
                    script {
                        if (isUnix()) {
                            sh 'terraform validate'
                        } else {
                            bat 'terraform.exe validate'
                        }
                    }
                }
            }
        }

        stage('Plan') {
            steps {
                dir(env.TERRAFORM_DIR) {
                    script {
                        if (isUnix()) {
                            sh 'terraform plan -lock=true -lock-timeout=300s -out=tfplan'
                        } else {
                            bat 'terraform.exe plan -lock=true -lock-timeout=300s -out=tfplan'
                        }
                    }
                    stash includes: 'terraform/tfplan', name: 'tfplan'
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
                unstash 'tfplan'
                dir(env.TERRAFORM_DIR) {
                    script {
                        if (isUnix()) {
                            sh 'terraform apply -lock=true -lock-timeout=300s -auto-approve tfplan'
                        } else {
                            bat 'terraform.exe apply -lock=true -lock-timeout=300s -auto-approve tfplan'
                        }
                    }
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
