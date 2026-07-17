#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Deploy Bravo Secure services to the Contabo staging box.
#
# Mechanism (the proven manual flow, scripted): rsync each service's source
# into ~/bravo on the box, then `docker compose build <svc>` and
# `up -d <svc>`, then verify the container is healthy. The Docker build runs
# the service's own typecheck/build (next build / nest build with
# ignoreBuildErrors=false), so a broken commit fails the build and the old
# container keeps running — build gates deploy.
#
# ⚠️  main is the source of truth. rsync uses --delete, so any file that
#     exists on the box but not in this checkout is removed. Server-side
#     hotfixes MUST be committed to main or they will be overwritten.
#     (.env* and build artefacts are excluded from the sync — see below.)
#
# Usage (local):
#   SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh ops-console
#   scripts/deploy-staging.sh all
#   scripts/deploy-staging.sh auth-service ops-console
#
# Usage (CI): the workflow exports BOX_* + writes the key to $SSH_KEY.
#
# Environment:
#   BOX_HOST   default 94.136.184.52
#   BOX_USER   default admin
#   BOX_DIR    default /home/admin/bravo
#   SSH_KEY    private key path; default ~/.ssh/bravo-staging.pem
#   COMPOSE    default docker-compose.staging.yml
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOX_HOST="${BOX_HOST:-94.136.184.52}"
BOX_USER="${BOX_USER:-admin}"
BOX_DIR="${BOX_DIR:-/home/admin/bravo}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bravo-staging.pem}"
COMPOSE="${COMPOSE:-docker-compose.staging.yml}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
REMOTE="$BOX_USER@$BOX_HOST"
# Common excludes: never ship local deps/build output or any env/secret file.
RSYNC_EXCLUDES=(--exclude node_modules --exclude .next --exclude dist
                --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo'
                --exclude .git)

ALL_SERVICES=(auth-service messenger-service ops-console)

# Resolve requested services.
if [[ $# -eq 0 || "${1:-}" == "all" ]]; then
  SERVICES=("${ALL_SERVICES[@]}")
else
  SERVICES=("$@")
fi

log()  { printf '\033[1;36m>> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

rsync_to_box() { # <local-relative> <remote-relative>
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" -e "ssh ${SSH_OPTS[*]}" \
    "$REPO_ROOT/$1/" "$REMOTE:$BOX_DIR/$2/"
}

sync_service() {
  case "$1" in
    auth-service)       rsync_to_box apps/auth-service apps/auth-service ;;
    messenger-service)  rsync_to_box apps/messenger-service apps/messenger-service
                        rsync_to_box packages/messenger-core packages/messenger-core ;;
    ops-console)        # build context is the box repo root → app + shared pkg + root .dockerignore
                        rsync_to_box apps/ops-console apps/ops-console
                        rsync_to_box packages/messenger-core packages/messenger-core
                        rsync -az -e "ssh ${SSH_OPTS[*]}" "$REPO_ROOT/.dockerignore" "$REMOTE:$BOX_DIR/.dockerignore" ;;
    *) fail "unknown service '$1' (expected: ${ALL_SERVICES[*]})" ;;
  esac
}

for svc in "${SERVICES[@]}"; do
  case " ${ALL_SERVICES[*]} " in *" $svc "*) : ;; *) fail "unknown service '$svc'";; esac
done

log "deploying to $REMOTE:$BOX_DIR — services: ${SERVICES[*]}"
ssh "${SSH_OPTS[@]}" "$REMOTE" "test -f '$BOX_DIR/$COMPOSE'" || fail "compose file $BOX_DIR/$COMPOSE not found on box"

for svc in "${SERVICES[@]}"; do
  log "sync $svc"
  sync_service "$svc"
  log "build $svc (this also typechecks the service)"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' build $svc" \
    || fail "build failed for $svc — NOT restarting; previous container stays up"
  log "restart $svc"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' up -d $svc"
done

log "waiting for healthchecks…"
rc=0
# Poll each service's health for up to ~2min. A container's healthcheck sits
# in "starting" for the first several probes after a restart, so we must wait
# for it to settle rather than check once — but a genuinely broken container
# (crash-loop) never reaches healthy and correctly fails after the timeout.
HEALTH_ATTEMPTS=40   # × 3s ≈ 120s
for svc in "${SERVICES[@]}"; do
  status=starting
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    status=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && cid=\$(docker compose -f '$COMPOSE' ps -q $svc) && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \$cid" 2>/dev/null || echo "unknown")
    # "healthy" (has healthcheck) or "running" (no healthcheck) = done.
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then break; fi
    sleep 3
  done
  case "$status" in
    healthy|running) printf '\033[1;32mOK   %s -> %s\033[0m\n' "$svc" "$status" ;;
    *)               printf '\033[1;31mFAIL %s -> %s\033[0m\n' "$svc" "$status"; rc=1 ;;
  esac
done

[[ $rc -eq 0 ]] && log "deploy complete ✓" || fail "one or more services unhealthy — check: docker compose -f $COMPOSE logs <svc>"
exit $rc
