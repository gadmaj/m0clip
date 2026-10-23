#!/usr/bin/env bash
set -euo pipefail
M0CLIP_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export M0CLIP_PROJECT_ROOT
exec "$M0CLIP_PROJECT_ROOT/deploy/access/m0clip-omp-local" "$@"
