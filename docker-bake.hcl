variable "TAG" {
  default = "latest"
}

variable "REGISTRY" {
  default = "ghcr.io/bridgetthnkechi87-cloud"
}

group "default" {
  targets = ["backend", "frontend"]
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
  cache-from = ["type=registry,ref=${REGISTRY}/very-prince-backend:buildcache"]
  cache-to   = ["type=registry,ref=${REGISTRY}/very-prince-backend:buildcache,mode=max"]
  output     = ["type=registry"]
}

target "frontend" {
  context    = "."
  dockerfile = "packages/frontend/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${REGISTRY}/very-prince-frontend:${TAG}"]
  cache-from = ["type=registry,ref=${REGISTRY}/very-prince-frontend:buildcache"]
  cache-to   = ["type=registry,ref=${REGISTRY}/very-prince-frontend:buildcache,mode=max"]
  output     = ["type=registry"]
}

// Usage examples (run from repo root):
//
// 1. Local build with default cache (pushes to registry, requires auth):
//    docker buildx bake
//
// 2. Local build without pushing (load into local Docker daemon):
//    docker buildx bake --set "*.output=type=docker"
//
// 3. Override tag:
//    docker buildx bake --set "*.tags=myregistry/very-prince-backend:v1.2.3"
//
// 4. Disable registry cache (use local BuildKit cache only):
//    docker buildx bake --set "*.cache-from=[]" --set "*.cache-to=[]"
//
// 5. Build only backend:
//    docker buildx bake backend
//
// Notes:
// - The registry cache refs must be accessible from the build host.
// - For CI (Jenkins), the Jenkinsfile uses the same refs but with
//   BUILDKIT_CACHE_REF_BACKEND/FRONTEND environment variables.
// - BuildKit inline cache is exported via --cache-to mode=max so that
//   the image itself can serve as a cache source for subsequent builds.
