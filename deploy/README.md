# Running the recorders on a box you control

## Why

GitHub does not honour short crons. This repo asks for `*/30` and
measures gaps of **45 minutes to 3.5 hours**, so the recorders run for
330 minutes at a stretch to approach continuous coverage. Measured
result: **303 of 602 windows captured — about half.**

The price path **cannot be backfilled**. Two independent checks confirm
it: a settled market reports only its last price, and Kairos 1-minute
candles fall inside our recorded book just **11.4%** of the time. So
every window missed is gone permanently, and halving coverage halves
the dataset forever.

A machine with a real cron fixes that. It also stops ad-hoc analysis
queueing behind 330-minute recorder jobs.

**It does NOT make the repo private.** That is a separate switch. What
it does is remove the cost barrier: going private today would bill
~89,000 Actions minutes a month at roughly $690, and moving the
recorders off Actions drops that to near zero.

## What NOT to do

**Do not attach a self-hosted GitHub Actions runner to this repository.**
It is public, so anyone could open a pull request with
`runs-on: self-hosted` and execute arbitrary code on the box — with the
Supabase service-role key in its environment. GitHub's own guidance says
to use self-hosted runners only with private repos.

These units run the scripts under **plain systemd**, with no GitHub
runner involved, which sidesteps the problem entirely.

## Setup

A small box is plenty — the work is network-bound, not CPU-bound.
Hetzner CX22, DigitalOcean or Vultr at $4-6/month are all far more
machine than this needs.

```bash
# 1. Harden first. The box will hold a service-role key.
adduser --system --group --home /opt/marketslap marketslap
# SSH keys only, passwords off, then:
ufw allow OpenSSH && ufw --force enable
apt update && apt install -y nodejs git unattended-upgrades

# 2. Clone. The repo is public, so no deploy key is needed.
git clone https://github.com/albatrossbird/housedge /opt/marketslap
chown -R marketslap:marketslap /opt/marketslap

# 3. Secrets, on the box only — never in git, never pasted into chat.
mkdir -p /etc/marketslap
cat > /etc/marketslap/env <<'EOF'
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
EOF
chmod 600 /etc/marketslap/env

# 4. Install the units.
cp /opt/marketslap/deploy/*.service /opt/marketslap/deploy/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now marketslap-update.timer
systemctl enable --now marketslap-m15.service
```

**Migrate one job first.** Start with `marketslap-m15` only, leave
weather on Actions, and run both for a couple of days. If coverage does
not actually improve, you have learned that cheaply. Only disable the
Actions schedule once the box has proven itself.

## Deploying is a git push

`marketslap-update.timer` pulls every 10 minutes and the services cycle
hourly, so a merge to `main` is live within the hour with no SSH. That
is what keeps this workable from a phone.

It uses `git reset --hard` rather than `git pull`: a merge conflict on
an unattended box is a recorder that silently stops.

## Knowing when it dies

A dead box produces no red workflow — it produces **silence**, which
looks exactly like a quiet market. `.github/workflows/watchdog.yml`
runs every six hours and fails red when nothing has written recently.

**The data is the heartbeat.** It reads `max(observed_at)` from the
tables rather than a separate "I am alive" ping, because a ping would
report a process that is running and writing nothing — the exact
failure mode this project keeps finding. A read that fails is reported
as UNREADABLE rather than passing.

## Checking on it

```bash
systemctl status marketslap-m15
journalctl -u marketslap-m15 -n 50 --no-pager
systemctl list-timers 'marketslap-*'
```
