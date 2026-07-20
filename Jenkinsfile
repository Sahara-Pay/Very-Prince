pipeline {
    agent {
        label 'terraform'
    }

    environment {
        TF_VERSION = '1.9.0'
        AWS_DEFAULT_REGION = 'us-east-1'
        TERRAFORM_DIR = 'terraform'
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
                    } else {
                        bat 'terraform.exe -version'
                        bat 'aws --version'
                    }
                }
            }
        }

        stage('Init') {
            steps {
                dir(env.TERRAFORM_DIR) {
                    script {
                        if (isUnix()) {
                            sh 'terraform init'
                        } else {
                            bat 'terraform.exe init'
                        }
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
                            sh 'terraform plan -out=tfplan'
                        } else {
                            bat 'terraform.exe plan -out=tfplan'
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
                            sh 'terraform apply -auto-approve tfplan'
                        } else {
                            bat 'terraform.exe apply -auto-approve tfplan'
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
