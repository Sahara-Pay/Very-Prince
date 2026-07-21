variable "TAG" {
  default = "latest"
}

group "default" {
  targets = ["backend", "frontend"]
}

target "backend" {
  context    = "."
  dockerfile = "packages/backend/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["very-prince-backend:${TAG}"]
  cache-from = ["type=registry,ref=very-prince-backend:cache"]
  cache-to   = ["type=registry,ref=very-prince-backend:cache,mode=max"]
}

target "frontend" {
  context    = "."
  dockerfile = "packages/frontend/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["very-prince-frontend:${TAG}"]
  cache-from = ["type=registry,ref=very-prince-frontend:cache"]
  cache-to   = ["type=registry,ref=very-prince-frontend:cache,mode=max"]
}