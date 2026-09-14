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

## Choosing the box

**The workload is network-bound, and that decides more than it looks
like it does.** Measured: one recorder tick costs ~400ms of CPU across
26 series, at a 12-second cadence — **about 5% of one core**, plus the
weather loop. Every candidate box has one to two orders of magnitude
more CPU than that.

So the benchmark that separates VPS providers — sustained compute,
where dedicated vCPUs beat burstable ones badly — is measuring
something these scripts never do. A burstable instance's *baseline*
alone (10-20%) has multiples of headroom, and the one genuinely bursty
thing here, `npm ci` on deploy, is exactly what burst credits are for.

Latency does not decide it either. Kalshi is **CloudFront → an AWS
ALB**; Polymarket is **Cloudflare, edge `IAD`**. Both are CDN-fronted,
so any US east coast host is within a few milliseconds of the same
edge, and the recorder polls every 12 seconds regardless.

What DOES decide it is whether the venue throttles the address.
Widening the refresh poll list once drew **sixteen straight HTTP
429s**, and a series that exhausts its retries freezes until the next
run. That is a property of the provider's IP range, not its hardware,
and it is the failure that has actually cost this project data.

**So measure it rather than reasoning about it.** The candidates bill
hourly, so this costs a few cents:

```bash
node scripts/venue-probe.mjs --minutes=10
```

It runs the recorder's real request rate against the real endpoints and
counts 429s, separating them from network failures — the two argue for
opposite conclusions. A clean result means take the cheaper box.

## Setup

One command on a fresh Ubuntu box, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/albatrossbird/housedge/main/deploy/bootstrap.sh | bash
```

That installs Node 22, creates a no-login service account, clones the
repo, enables unattended security upgrades, sets the firewall to
inbound-SSH-only, and installs the units. It is idempotent.

**It deliberately does not write the secrets.** A script taking a
service-role key as an argument puts it in shell history and in the
process list. It prints what to do instead:

```bash
install -m 600 /dev/null /etc/marketslap/env
nano /etc/marketslap/env      # typed, not piped
```

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
```

Then probe the address, then start **one** job:

```bash
sudo -u marketslap node /opt/marketslap/scripts/venue-probe.mjs --minutes=10
systemctl enable --now marketslap-update.timer
systemctl enable --now marketslap-m15.service
journalctl -u marketslap-m15 -f
```

**Migrate one job first.** Leave weather on Actions and run both for a
couple of days. If coverage does not actually improve, you have learned
that cheaply. Only disable the Actions schedule once the box has proven
itself.

## Closing SSH to the internet

Optional, and worth doing — but **in this order**, because closing
port 22 first is how people lock themselves out:

1. Take a provider snapshot.
2. `curl -fsSL https://tailscale.com/install.sh | sh && tailscale up` on
   the box, and install Tailscale on your laptop.
3. **Verify** `ssh marketslap-box` over the tailnet address works.
4. Only then: `ufw delete allow OpenSSH && ufw allow in on tailscale0`.

## The credential is the real exposure

The box holds `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS entirely
— full read and write on every table. The hardening above protects the
box; nothing above limits what the key can do if the box is lost.

The actual fix is a dedicated Postgres role with INSERT/UPDATE granted
only on the recorder tables, used through PostgREST with its own JWT,
so a compromised box can append quotes and nothing else. That is real
work rather than a checkbox, and it is the right next step **after**
the box is up and recording — not a reason to delay it.

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
