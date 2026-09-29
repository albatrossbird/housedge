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

**So measure it rather than reasoning about it.** The candidates bill by
the hour or the second, so this costs a few cents:

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
SUPABASE_ANON_KEY=<the anon key>
```

`scripts/watchdog.mjs` can be run **on the box**, answering "is anything
actually landing" without leaving it — a recorder that runs and writes
nothing is this project's most common failure, and `systemctl status`
reports it as active. It reads with the **service** key: the recorded
archives are private (migration 0028), and the anon key alone gets
`permission denied` on them. Run it through systemd so the env file is
read the way the services read it:

```bash
sudo systemd-run --quiet --wait --pipe --uid=marketslap \
  -p EnvironmentFile=/etc/marketslap/env \
  /usr/bin/node /opt/marketslap/scripts/watchdog.mjs
```

Grepping the file from your login shell does not work: it is root-owned
and mode 600.

Then probe the address, then start **one** job:

```bash
sudo -u marketslap node /opt/marketslap/scripts/venue-probe.mjs --minutes=10
systemctl enable --now marketslap-update.timer
systemctl enable --now marketslap-m15.service
journalctl -u marketslap-m15 -f
```

**The box is AWS Lightsail, us-east-1, the $7 tier** — 2 vCPU, 1 GB,
40 GB, 2 TB transfer. Not the $5 tier: 0.5 GB is thin for Node plus two
recorder processes plus an `npm ci` on deploy, and an out-of-memory kill
on an unattended box costs more than the $2 saved.

**This was Hetzner until the prices moved, and the correction is worth
recording rather than quietly editing.** Hetzner Ashburn was the pick at
$5.85/month against Lightsail's $12 for the same specs, with the only
argument against it an unverified claim about IP reputation. Hetzner
then raised US prices roughly 3x on 15 June 2026 — CPX11 in Ashburn went
$6.99 to $20.49 — with a second rise in August. Lightsail now wins on
price AND on transfer at identical specs, so both halves of the original
argument reversed at once.

The lesson is about the figure, not the vendor: a price quoted from
memory is a measurement with no date on it, and this one was three
months stale while reading as current. Check the vendor's own page
before acting on any number here.

Nothing else changes. bootstrap.sh, venue-probe.mjs, the secrets file
and the systemd units do not know which company owns the box.

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

### Before the repo goes private: a read-only deploy key

The pull used to be anonymous HTTPS, which stops working the moment the
repo is private — and nothing breaks visibly: the recorders keep running
their last code and new code simply stops arriving. So the box pulls
over SSH with a **read-only deploy key**, set up while the repo is still
public. **Box terminal**:

    sudo bash /opt/marketslap/deploy/git-deploy-key.sh

The first run makes the key and prints its public half with where to
paste it on GitHub (Settings -> Deploy keys; leave write access
UNTICKED). Run the same command again afterwards; it must end with
`DONE`. Then prove the update job itself works:

    sudo systemctl start marketslap-update.service
    systemctl status marketslap-update --no-pager | head -5

It must not say `failed`.

### A new box, once the repo is private

`curl ... bootstrap.sh | bash` cannot work any more: the raw URL needs
a login. Make the key first, clone over SSH, then bootstrap from the
clone. **Box terminal**, one at a time:

    sudo adduser --system --group --home /opt/marketslap --shell /usr/sbin/nologin marketslap
    sudo install -d -o marketslap -g marketslap -m 700 /var/lib/marketslap-git
    sudo -u marketslap ssh-keygen -q -t ed25519 -N "" -f /var/lib/marketslap-git/deploy_key
    sudo cat /var/lib/marketslap-git/deploy_key.pub

Add that line at GitHub -> the repo -> Settings -> Deploy keys (write
access unticked), then:

    echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' | sudo -u marketslap tee /var/lib/marketslap-git/known_hosts
    sudo -u marketslap env GIT_SSH_COMMAND="ssh -i /var/lib/marketslap-git/deploy_key -o UserKnownHostsFile=/var/lib/marketslap-git/known_hosts" git clone git@github.com:albatrossbird/housedge.git /opt/marketslap/repo-tmp
    sudo bash -c 'shopt -s dotglob && mv /opt/marketslap/repo-tmp/* /opt/marketslap/ && rmdir /opt/marketslap/repo-tmp'
    sudo bash /opt/marketslap/deploy/bootstrap.sh
    sudo bash /opt/marketslap/deploy/git-deploy-key.sh

(The host key line is GitHub's published Ed25519 key, from
docs.github.com's "GitHub's SSH key fingerprints" page.)

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

## The WebSocket recorder (`marketslap-m15-stream.service`)

Records every book change on the 15-minute markets, the settlement index
at 5Hz and every trade, from Kalshi's authenticated WebSocket. Runs
beside the 15-second poller, not instead of it. Files go to the private
Storage bucket `stream-archive` (migration `0029`), an hour per file.

It needs a Kalshi API key. **The key on the box is read-only.** Choose
read-only on kalshi.com if it offers it; the script below then just puts
that key in place. Given a full-access key instead, it uses it once to
mint a read-only key and then deletes the full-access one.

1. On kalshi.com: Account -> Profile -> API Keys -> Create New API Key.
   Keep the page open; it shows the Key ID and the private key once.
2. On the box, put the private key in a root-only file (paste it into
   nano, then Ctrl-O, Enter, Ctrl-X):

       sudo install -m 600 /dev/null /etc/marketslap/kalshi-temp.pem
       sudo nano /etc/marketslap/kalshi-temp.pem

3. Mint the read-only key and delete the temporary one. Type the Key ID
   after the `=` with no brackets or quotes:

       sudo KALSHI_TEMP_KEY_ID=paste-the-key-id-here node /opt/marketslap/scripts/kalshi-key-setup.mjs

   It must end with `DONE`. It verifies the new key's scope with Kalshi's
   own key list and refuses to finish on a key that can trade.
4. Prove the stream from this box (about a minute, writes nothing):

       sudo systemd-run --quiet --wait --pipe --uid=marketslap \
         -p EnvironmentFile=/etc/marketslap/env \
         -p LoadCredential=kalshi.pem:/etc/marketslap/kalshi-read.pem \
         /usr/bin/node /opt/marketslap/scripts/kalshi-ws-probe.mjs

   It must end with `ALL REQUIRED CHECKS PASSED`.
5. Start it, then check it is writing:

       sudo systemctl enable --now marketslap-m15-stream.service
       sudo journalctl -u marketslap-m15-stream -n 25 --no-pager

## The Polymarket US recorder (`marketslap-pmus15-stream.service`)

Records Polymarket US's 15-minute Bitcoin "Up or Down" books, beside the
Kalshi recorder, so the same window can be compared on both venues at the
same instant. They are the same claim as Kalshi's `KXBTC15M` (same index,
same averaging, same tie rule). Files go to `stream-archive` under
`pmus15/`.

It uses the box's .us key **in place**: the id in `/etc/polyus/id.env`,
the secret in `/etc/polyus/polyus.key`. Nothing needs creating. **That
key can trade**, so this repo only ever opens the market-data socket with
it, and the account must stay at $0 while the key exists.

All commands are for the **box terminal**, one at a time.

1. Pick up the new unit file:

       sudo systemctl start marketslap-update.service
       sudo systemctl start marketslap-sync.service

2. Prove the socket from this box (about 40 seconds, writes nothing):

       sudo systemd-run --quiet --wait --pipe --uid=marketslap \
         -p EnvironmentFile=/etc/polyus/id.env \
         -p LoadCredential=polyus.key:/etc/polyus/polyus.key \
         /usr/bin/node /opt/marketslap/scripts/pmus15-probe.mjs

   It must end with `ALL REQUIRED CHECKS PASSED`. `same side` compares
   the book against Kalshi's live book for the same window.
3. Start it, then check it is writing (after about a minute):

       sudo systemctl enable --now marketslap-pmus15-stream.service
       sudo journalctl -u marketslap-pmus15-stream -n 25 --no-pager

   Look for `socket open` and no `::error::`. The first stats line
   (`books=... booksWritten=... uploads=...`) prints after 5 minutes; the
   first upload lands at the top of the next hour.

If the .us key is ever deleted, the unit fails within a minute with
`refused 5 handshakes in a row while the gateway is up` and does not
restart. That is expected; disable it with
`sudo systemctl disable marketslap-pmus15-stream.service`. (If the
gateway is down too, it treats that as an outage and keeps retrying
every 60 seconds.)

## The price refresh (`marketslap-refresh.timer`)

Updates the site's prices every 5 minutes, which GitHub Actions only
promises and delivers every 45 minutes to 3.5 hours. It is the same
`scripts/refresh-prices.mjs` the `Refresh prices` workflow runs, with the
same alarms, and it uses `SUPABASE_URL` and `SUPABASE_ANON_KEY` from
`/etc/marketslap/env`, which bootstrap already asked for.

    sudo systemctl start marketslap-sync.service
    sudo systemctl enable --now marketslap-refresh.timer

After about 5 minutes, check it ran cleanly (the last line reads
`kalshi updated: N/M fetched, polymarket updated: ...`, and the unit is
not `failed`):

    sudo journalctl -u marketslap-refresh -n 15 --no-pager
    systemctl status marketslap-refresh --no-pager | head -5

The Actions workflow keeps running until the box has been seen to keep
prices fresh; both writing the same prices is harmless. Its schedule is
turned off in a follow-up once that is measured.
