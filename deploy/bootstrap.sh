#!/usr/bin/env bash
# Provision a fresh Ubuntu box to run the recorders.
#
# Run as root on a BRAND NEW box, once. Idempotent — safe to re-run.
#
# It deliberately does NOT write the secrets file. That is the one step
# that must be done by hand, because a script that takes a service-role
# key as an argument puts it in the shell history and in the process
# list where any user on the box can read it.
#
#   curl -fsSL https://raw.githubusercontent.com/albatrossbird/housedge/main/deploy/bootstrap.sh | bash
#
# then follow the instructions it prints.

set -euo pipefail

REPO=https://github.com/albatrossbird/housedge
DIR=/opt/marketslap
ENVFILE=/etc/marketslap/env
USER=marketslap

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ufw unattended-upgrades ca-certificates

# Ubuntu ships Node 18; these scripts are ESM and assume a current
# runtime. NodeSource is the supported way to get a modern one.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "node $(node -v)"

say "unattended security upgrades"
# Patching is not optional on a box holding a database credential.
dpkg-reconfigure -f noninteractive unattended-upgrades

say "service account"
# --system so it cannot be logged into, and no shell.
id -u "$USER" >/dev/null 2>&1 || adduser --system --group --home "$DIR" --shell /usr/sbin/nologin "$USER"

say "code"
# The repo is public, so no deploy key — and therefore no credential on
# the box that could push back to GitHub.
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin main && git -C "$DIR" reset --hard --quiet origin/main
else
  git clone --quiet "$REPO" "$DIR"
fi
chown -R "$USER:$USER" "$DIR"
git config --global --add safe.directory "$DIR"

say "dependencies"
# The recorder scripts are REST-only and need nothing, but the update
# timer runs npm ci so a future dependency does not silently break the
# box. Brief and bursty, which is what a burstable instance is for.
cd "$DIR" && npm ci --omit=dev --silent 2>/dev/null || echo "  (no lockfile install needed)"
chown -R "$USER:$USER" "$DIR"

say "firewall"
# Inbound SSH only. Nothing here serves traffic; the recorders make
# OUTBOUND calls and outbound is unrestricted by default.
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

say "systemd units"
install -m 0644 "$DIR"/deploy/*.service "$DIR"/deploy/*.timer /etc/systemd/system/
systemctl daemon-reload

mkdir -p "$(dirname "$ENVFILE")"
chmod 700 "$(dirname "$ENVFILE")"

cat <<EOF

========================================================================
Box is provisioned. Two things left, and they are yours to do by hand.

1. WRITE THE SECRETS. Not through this script and not over a pipe —
   type them into the editor so they stay out of shell history:

     sudo install -m 600 /dev/null $ENVFILE
     sudo nano $ENVFILE

   Type these three names, then paste each key DIRECTLY after its
   '=' with nothing else on the line:

     SUPABASE_URL=
     SUPABASE_SERVICE_ROLE_KEY=
     SUPABASE_ANON_KEY=

   NO ANGLE BRACKETS, no quotes, no spaces around '='. This used to be
   written as `<the service_role key>` and the brackets were kept along
   with the key — systemd's EnvironmentFile takes the value literally,
   so a perfectly good key was sent as `<key>` and refused with
   `401 Invalid API key` for fourteen hours while the recorder happily
   restarted. A placeholder you are meant to delete part of is a
   placeholder that will be pasted over in part.

   The anon key belongs here even though the recorders do not write
   with it: scripts/watchdog.mjs reads through it, and being able to
   ask the box "is anything actually landing" without leaving the box
   is the difference between checking and assuming. It is public by
   design — it ships to every browser — so it adds no exposure.

   Save with Ctrl+X, then Y, then Enter. Ctrl+O also saves, but a
   browser-based terminal hands that shortcut to the browser instead,
   so the file looks unsaved when it is simply unsent.

   If your terminal pastes '^[[200~' as literal text, it is leaking
   bracketed-paste markers into the line. Type this once, by hand, and
   paste again:

     bind 'set enable-bracketed-paste off'

   Then confirm nothing else can read it, and that no marker landed
   inside a key:

     sudo chmod 600 $ENVFILE && sudo ls -l $ENVFILE
     sudo grep -c '200~' $ENVFILE     # must print 0

2. PROVE THE ADDRESS IS NOT THROTTLED before you commit to this host.
   Ten minutes, no credentials needed:

     sudo -u $USER node $DIR/scripts/venue-probe.mjs --minutes=10

   Any 429 in that output is the failure that freezes series for hours.
   If you see them, try the other provider — it is the IP range, not
   the hardware.

Only then start recording. ONE JOB FIRST:

     sudo systemctl enable --now marketslap-update.timer
     sudo systemctl enable --now marketslap-m15.service
     sudo journalctl -u marketslap-m15 -f

Then confirm rows are LANDING, not just that a process is running —
a recorder that runs and writes nothing is this project's most common
failure:

     sudo -u $USER --preserve-env=SUPABASE_URL,SUPABASE_ANON_KEY \
       env \$(grep -E '^SUPABASE_(URL|ANON_KEY)=' $ENVFILE | xargs) \
       node $DIR/scripts/watchdog.mjs

Leave weather on GitHub Actions for a couple of days and compare. If
coverage does not actually improve, you have learned that cheaply.
========================================================================
EOF
