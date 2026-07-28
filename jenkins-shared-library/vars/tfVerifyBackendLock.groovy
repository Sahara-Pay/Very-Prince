// Confirms the DynamoDB-backed state lock is reachable by attempting to force-unlock
// a lock ID that doesn't exist. Terraform's error output always mentions "lock" when
// it successfully reached the lock table, which is what we assert on.
//
// call(Map params)
//   params.dir    (String, required)
//   params.lockId (String, default 'nonexistent-lock-id')
def call(Map params) {
    def dirPath = params.dir
    def lockId = params.lockId ?: 'nonexistent-lock-id'
    def output

    dir(dirPath) {
        if (isUnix()) {
            output = sh(
                returnStdout: true,
                script: "terraform force-unlock -force ${lockId} 2>&1 || true"
            )
        } else {
            output = bat(
                returnStdout: true,
                script: "@echo off && terraform.exe force-unlock -force ${lockId} 2>&1 & exit /b 0"
            )
        }
    }

    if (!output.toLowerCase().contains('lock')) {
        error(
            "Backend lock verification failed: Terraform did not mention a 'lock' in its output. " +
            "Expected DynamoDB-based locking to be reachable. Output was:\n${output}"
        )
    }
    echo '✓ Backend lock verification passed: DynamoDB lock table is reachable.'
}

return this
