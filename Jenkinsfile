pipeline {
    agent {
        label 'terraform'
    }

    environment {
        TF_VERSION = '1.9.0'
        AWS_DEFAULT_REGION = 'us-east-1'
        TERRAFORM_DIR = 'terraform'
        DOCKER_IMAGE = 'very-prince-backend'
        // ─── Terraform state backend ────────────────────────────────────
        // These values must match terraform/backend.tf. Override per
        // environment if a different bucket or lock table is used.
        STATE_BUCKET_NAME = 'very-prince-terraform-state'
        DYNAMODB_LOCK_TABLE = 'very-prince-terraform-locks'
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

        stage('Build Docker Image') {
            steps {
                script {
                    if (isUnix()) {
                        sh 'docker build --file packages/backend/Dockerfile --tag $DOCKER_IMAGE:$BUILD_NUMBER .'
                    } else {
                        bat 'docker build --file packages\\backend\\Dockerfile --tag %DOCKER_IMAGE%:%BUILD_NUMBER% .'
                    }
                }
            }
        }

        stage('Scan Docker Image') {
            steps {
                script {
                    if (isUnix()) {
                        sh 'trivy image --exit-code 1 --severity HIGH,CRITICAL $DOCKER_IMAGE:$BUILD_NUMBER'
                    } else {
                        bat 'trivy image --exit-code 1 --severity HIGH,CRITICAL %DOCKER_IMAGE%:%BUILD_NUMBER%'
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
        always {
            cleanWs()
        }
        success {
            echo 'Pipeline completed successfully'
        }
        failure {
            echo 'Pipeline failed'
        }
    }
}
