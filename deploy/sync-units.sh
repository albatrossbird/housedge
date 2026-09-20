#!/usr/bin/env bash
# Make unit files deploy the way code already does.
#
# THE GAP THIS CLOSES. marketslap-update.service pulls the repo, so a
# code change reaches the box on its own. Unit files do not: they are
# copies bootstrap.sh took once into /etc/systemd/system, and the update
# job runs as `marketslap`, which cannot write there. A .service change
# therefore lands in git and is ignored by the running box, silently.
#
# Measured cost of that, over two days: three separate unit defects each
# needing a human to re-run bootstrap — root@ vs ubuntu@, an
# M15_SOURCE that could never arrive, and a crash-loop limit systemd was
# openly ignoring. The last one meant a guarantee in a commit message
# was false on every running box.
#
# WHAT IT DOES NOT DO is run anything new on its own judgement. It syncs
# units that already exist under deploy/, reloads systemd, and restarts
# only units that were ALREADY enabled and running. Enabling a service
# for the first time stays a human decision, because "start recording
# something" is not a change that should arrive by git pull.
set -euo pipefail

DIR=${DIR:-/opt/marketslap}
DEST=/etc/systemd/system
SRC="$DIR/deploy"

[ "$(id -u)" -eq 0 ] || { echo "sync-units must run as root"; exit 1; }

changed=()
shopt -s nullglob
for f in "$SRC"/marketslap-*.service "$SRC"/marketslap-*.timer; do
  name=$(basename "$f")
  # Only ever our own units, by name. A sync that copied whatever it
  # found would let any file added to deploy/ become a root service.
  case "$name" in marketslap-*.service|marketslap-*.timer) ;; *) continue ;; esac
  if ! cmp -s "$f" "$DEST/$name"; then
    install -m 0644 "$f" "$DEST/$name"
    changed+=("$name")
  fi
done

if [ ${#changed[@]} -eq 0 ]; then
  echo "units: no change"
  exit 0
fi

echo "units changed: ${changed[*]}"
systemctl daemon-reload

# Restart only what was already running. A unit that is installed but
# not enabled is one somebody chose not to start, and a sync job is not
# the thing to overrule that.
for name in "${changed[@]}"; do
  case "$name" in
    *.service)
      if systemctl is-enabled --quiet "$name" 2>/dev/null && systemctl is-active --quiet "$name" 2>/dev/null; then
        echo "  restarting $name"
        systemctl restart "$name"
      else
        echo "  $name updated but not running — left alone"
      fi
      ;;
    *.timer)
      if systemctl is-enabled --quiet "$name" 2>/dev/null; then
        echo "  restarting $name"
        systemctl restart "$name"
      fi
      ;;
  esac
done
