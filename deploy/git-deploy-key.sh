#!/usr/bin/env bash
# Give the box READ-ONLY access to the repo over SSH, so it keeps pulling
# code once the repo is private. Run as root; idempotent — run it again
# after adding the key to GitHub, and it finishes the switch.
#
#   sudo bash /opt/marketslap/deploy/git-deploy-key.sh
#
# WHY. marketslap-update.service pulls over public HTTPS with no
# credential. The day the repo goes private, that fetch fails, and the
# recorders keep running whatever code they last had — nothing breaks
# visibly, new code simply stops arriving. So this runs BEFORE the switch,
# while the old path still works.
#
# A DEPLOY KEY, NOT A PERSONAL TOKEN. A deploy key is scoped to this one
# repository, is read-only unless write is ticked when adding it, and does
# not expire. A personal access token would reach every repo the account
# can, and expires. Do NOT tick "Allow write access": the box never pushes.
#
# WHERE THE KEY LIVES. The service account's home is /opt/marketslap —
# the checkout itself, which the update timer resets — so the key goes in
# /var/lib/marketslap-git, owned by marketslap, mode 700. That user can
# read it; that is unavoidable, since that user runs the fetch, and the
# worst it grants is reading this repository.
#
# GITHUB'S HOST KEYS ARE PINNED, not trusted on first use: read from
# api.github.com over TLS, with GitHub's published Ed25519 key as the
# fallback, and StrictHostKeyChecking=yes.

set -euo pipefail

DIR=/opt/marketslap
USER=marketslap
KEYDIR=/var/lib/marketslap-git
KEY=$KEYDIR/deploy_key
KNOWN=$KEYDIR/known_hosts
SSH_URL=git@github.com:albatrossbird/housedge.git
# From https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_ED25519='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -d "$DIR/.git" ] || { echo "no checkout at $DIR"; exit 1; }

install -d -o "$USER" -g "$USER" -m 700 "$KEYDIR"

if [ ! -f "$KEY" ]; then
  sudo -u "$USER" ssh-keygen -q -t ed25519 -N "" -C "marketslap-box read-only deploy key" -f "$KEY"
  echo "made a new key at $KEY"
fi

# Host keys: the API's list if it answers, else the published Ed25519 key.
if curl -fsS --max-time 15 https://api.github.com/meta 2>/dev/null \
   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).ssh_keys||[];if(!k.length)process.exit(1);for(const x of k)console.log("github.com "+x)})' > "$KNOWN.tmp"; then
  grep -qxF "$GITHUB_ED25519" "$KNOWN.tmp" || echo "note: GitHub's API lists a different Ed25519 host key than this script pins — using the API's (it came over TLS)"
else
  echo "$GITHUB_ED25519" > "$KNOWN.tmp"
fi
mv "$KNOWN.tmp" "$KNOWN"
chown "$USER:$USER" "$KNOWN"; chmod 600 "$KNOWN"

SSHCMD="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN -o BatchMode=yes"
sudo -u "$USER" git -C "$DIR" config core.sshCommand "$SSHCMD"

if sudo -u "$USER" git -C "$DIR" ls-remote --quiet "$SSH_URL" HEAD >/dev/null 2>&1; then
  sudo -u "$USER" git -C "$DIR" remote set-url origin "$SSH_URL"
  sudo -u "$USER" git -C "$DIR" fetch --quiet origin main
  echo
  echo "DONE — the box now pulls over SSH with its deploy key."
  echo "origin: $(sudo -u "$USER" git -C "$DIR" remote get-url origin)"
  echo "latest: $(sudo -u "$USER" git -C "$DIR" log -1 --format='%h %s' origin/main)"
  exit 0
fi

cat <<EOF

NOT DONE YET — GitHub does not know this key. Add it, then run this again.

1. Open  https://github.com/albatrossbird/housedge/settings/keys/new
2. Title:  marketslap-box
3. Key:    paste the ONE line below (it starts with ssh-ed25519)
4. Leave "Allow write access" UNTICKED, then click Add key.

$(cat "$KEY.pub")

This line is the PUBLIC half and is safe to paste into GitHub. The
private half stays in $KEY and never leaves the box.
EOF
