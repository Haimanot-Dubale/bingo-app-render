# Hosting on AWS (players + agents + admin)

## Fastest way: the installer script
On a fresh Ubuntu EC2 server (security group: 22 from your IP, 80 and 443 from anywhere) with an RDS MySQL database:
```
unzip bingo-app-multiagent.zip && cd bingo-app-updated
bash install-aws.sh
```
It asks for your domain, RDS details, admin login and (optionally) SMTP once, then installs Node 22, nginx (with flood limits),
HTTPS (Let's Encrypt), PM2 (auto-restart on reboot), creates the tables, writes a secure `.env` and starts everything.
Safe to run again. For later updates: unzip the new version over the folder and run `bash update.sh`.

The sections below explain each step if you prefer to do it by hand.


## 1. Servers
* **EC2** (Ubuntu, t3.small or bigger) + **RDS MySQL 8** in the same VPC (security group: 3306 only from the EC2 group).
* Turn on **RDS automated backups** (7+ days). Money lives in the database.
* Run **ONE Node process** (live games are held in memory). `pm2 start server.js --name bingo` (no cluster mode, one instance behind any load balancer).
* A server restart is safe for money: running group games are cancelled and **refunded** automatically on start. Restart between rounds when possible.

## 2. Install
```
npm install
cp .env.example .env      # then edit it
```
Fill in `.env`:
* `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME` (RDS endpoint)
* `NODE_ENV=production`
* `SESSION_SECRET` = long random text (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
* `PUBLIC_URL=https://your-domain` (used in password-reset e-mails)
* `ALLOW_AGENT_SIGNUP=false` (create agents in the admin panel instead)
* `ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD` for the first admin (or run `npm run create-admin -- boss boss@mail.com 'StrongPass1'`), then delete ADMIN_PASSWORD
* SMTP (`SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM`) - e.g. Amazon SES, Gmail app password, any SMTP. Without it reset links only appear in the server log.
* `TZ_OFFSET_MINUTES=180` (Ethiopia) so "today / this week / this month" match local time.

The database schema upgrades itself on every start (`npm run migrate` does it by hand).

## 3. Optional: protected (obfuscated) front-end
```
npm install --save-dev terser javascript-obfuscator
npm run build        # creates ./dist ; used automatically when NODE_ENV=production
```
(Run it again after every change to `public/`. If anything looks wrong, delete `dist/` to fall back to the readable files.)

## 4. HTTPS + websockets (nginx)
```
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
Use a certificate (Let's Encrypt / ACM). Put **CloudFront + AWS WAF + Shield Standard** in front for real DDoS protection; the app's own limits cover application-level floods.

## 5. Go live checklist
1. Open `/admin`, log in, change the admin password, add your agents (each gets an Agent ID + temporary password).
2. Agents log in at `/cashier` (deposits, reports, withdrawals) and `/` (bingo hall console).
3. Players register at `/player.html`, then give cash to an agent with their phone number.
4. Check Settings (commission %, limits). Make a small test: deposit, 2 players, 1 game, 1 withdrawal.
5. Health check URL: `/health`.

Older versions could record a hall-game winner twice. To look for old duplicates:
`SELECT session_id, COUNT(*) FROM game_reports GROUP BY session_id HAVING COUNT(*) > 1;`
