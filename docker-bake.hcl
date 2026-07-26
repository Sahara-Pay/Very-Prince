variable "TAG" {
  default = "latest"
}

variable "REGISTRY" {
  default = "ghcr.io/bridgetthnkechi87-cloud"
}

variable "TURBO_FILTER" {
  default = ""
  description = "Optional Turborepo filter (e.g. '--filter=@very-prince/backend...'). Passed as --build-arg to Dockerfiles."
}

variable "LOCAL_CACHE_DIR" {
  default = "/tmp/buildkit-cache"
  description = "Local directory for BuildKit cache storage mounts"
}

group "default" {
  targets = ["backend", "frontend"]
}

group "distroless" {
  targets = ["backend-distroless", "frontend-distroless"]
}

group "alpine" {
  targets = ["backend-alpine", "frontend-alpine"]
}

target "backend" {
  context    = "."
  dockerfile = "packages/backend/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${REGISTRY}/very-prince-backend:${TAG}"]
  // Cache refs align with Jenkinsfile environment variables:
  //   BUILDKIT_CACHE_REF_BACKEND  = "${REGISTRY}/very-prince-backend:buildcache"
  //   BUILDKIT_CACHE_REF_FRONTEND = "${REGISTRY}/very-prince-frontend:buildcache"
  // Override with: docker buildx bake --set *.cache-from=... --set *.cache-to=...
  // Local cache storage mount for faster parallel builds
  cache-from = [
    "type=local,src=${LOCAL_CACHE_DIR}/backend",
    "type=registry,ref=${REGISTRY}/very-prince-backend:buildcache"
  ]
  cache-to   = [
    "type=local,dest=${LOCAL_CACHE_DIR}/backend,mode=max",
    "type=registry,ref=${REGISTRY}/very-prince-backend:buildcache,mode=max"
  ]
  output     = ["type=registry"]
  // TURBO_FILTER is passed as --build-arg so the Dockerfile's turbo runs
  // only build the target workspace + its deps (matches Jenkins behavior).
  // Override at build time: docker buildx bake --set "backend.args.TURBO_FILTER=--filter=@very-prince/backend..."
  args = {
    TURBO_FILTER = "${TURBO_FILTER}"
  }
}

target "frontend" {
  context    = "."
  dockerfile = "packages/frontend/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${REGISTRY}/very-prince-frontend:${TAG}"]
  // Local cache storage mount for faster parallel builds
  cache-from = [
    "type=local,src=${LOCAL_CACHE_DIR}/frontend",
    "type=registry,ref=${REGISTRY}/very-prince-frontend:buildcache"
  ]
  cache-to   = [
    "type=local,dest=${LOCAL_CACHE_DIR}/frontend,mode=max",
    "type=registry,ref=${REGISTRY}/very-prince-frontend:buildcache,mode=max"
  ]
  output     = ["type=registry"]
  args = {
    TURBO_FILTER = "${TURBO_FILTER}"
  }
}

// Alpine variants (smaller size, includes shell for debugging)
target "backend-alpine" {
  inherits   = ["backend"]
  dockerfile = "packages/backend/Dockerfile"
  target     = "runner-alpine"
  tags       = ["${REGISTRY}/very-prince-backend:${TAG}-alpine"]
}

target "frontend-alpine" {
  inherits   = ["frontend"]
  dockerfile = "packages/frontend/Dockerfile"
  target     = "runner-alpine"
  tags       = ["${REGISTRY}/very-prince-frontend:${TAG}-alpine"]
}

// Distroless variants (minimal attack surface, no shell)
target "backend-distroless" {
  inherits   = ["backend"]
  dockerfile = "packages/backend/Dockerfile"
  target     = "runner"
  tags       = ["${REGISTRY}/very-prince-backend:${TAG}-distroless"]
}

target "frontend-distroless" {
  inherits   = ["frontend"]
  dockerfile = "packages/frontend/Dockerfile"
  target     = "runner"
  tags       = ["${REGISTRY}/very-prince-frontend:${TAG}-distroless"]
}

// Usage examples (run from repo root):
//
// 1. Build default (Distroless) multi-platform images:
//    docker buildx bake
//
// 2. Build Alpine variants (includes shell for debugging):
//    docker buildx bake alpine
//
// 3. Build Distroless variants (minimal attack surface, no shell):
//    docker buildx bake distroless
//
// 4. Local build without pushing (load into local Docker daemon):
//    docker buildx bake --set "*.output=type=docker"
//
// 5. Override tag:
//    docker buildx bake --set "*.tags=myregistry/very-prince-backend:v1.2.3"
//
// 6. Disable registry cache (use local BuildKit cache only):
//    docker buildx bake --set "*.cache-from=[]" --set "*.cache-to=[]"
//
// 7. Build only backend:
//    docker buildx bake backend
//
// 8. Build with Turborepo filter (matches Jenkins dynamic behavior):
//    docker buildx bake --set "*.args.TURBO_FILTER=--filter=@very-prince/backend..." backend
//    docker buildx bake --set "*.args.TURBO_FILTER=--filter=@very-prince/frontend..." frontend
//
// 9. Build specific platform:
//    docker buildx bake --set "*.platforms=linux/amd64" backend
//
// 10. Use custom local cache directory:
//     docker buildx bake --set LOCAL_CACHE_DIR=/my/custom/cache
//
// Notes:
// - Multi-platform builds (linux/amd64, linux/arm64) are enabled by default.
// - Local cache storage mounts provide faster parallel builds by avoiding network round-trips.
// - Registry cache is used as a fallback for distributed builds across multiple machines.
// - Distroless images have no shell - use Alpine variants if debugging access is needed.
// - The registry cache refs must be accessible from the build host.
// - For CI (Jenkins), the Jenkinsfile uses the same refs but with
//   BUILDKIT_CACHE_REF_BACKEND/FRONTEND environment variables.
// - BuildKit inline cache is exported via --cache-to mode=max so that
//   the image itself can serve as a cache source for subsequent builds.
