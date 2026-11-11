# Before real players and real money

## MUST do (do not go live without these)
1. **HTTPS.** On plain http, passwords and login tokens travel readable. Get a domain (or a temporary
   `13-62-147-115.sslip.io` name) and re-run:  `AUTO=1 DOMAIN='your.domain' LE_EMAIL='you@mail.com' bash install-aws.sh`
2. **Backups you can restore.** The installer saves a database copy every 6 h on the same disk. ALSO turn on EBS snapshots
   (EC2 -> Lifecycle Manager) and test restoring one. Money lives only in this database.
3. **Change the first admin password and e-mail** (Admin -> Admins -> Change my password; `node create-admin.js boss real@mail 'NewPass1'`).
4. **E-mail (SMTP) or a support routine.** Without SMTP nobody can reset a forgotten password by e-mail - the admin must
   reset it (Admin -> Players -> Password). Decide who answers players.
5. **Licence / legal.** Public real-money games normally need a licence and terms of service. Check this before launch.
6. **Pilot first** (1-2 weeks, a few agents, small amounts): deposit -> game -> win -> withdrawal -> settlement, compare the
   admin numbers with the real cash every day.

## Decide (not built; business rules)
* **Agent credit limit.** An agent can deposit without collecting cash and the money can be withdrawn at another agent. The
  admin sees what each agent owes, but nothing stops a dishonest agent. Consider a maximum "owed" amount per agent.
* **Play-through before withdrawal** (e.g. must stake 100% of deposits) against deposit -> withdraw laundering.
* Phone/e-mail verification (OTP), ID checks, deposit/loss limits, self-exclusion.

## Worth knowing
* One server process: a restart refunds running GROUP games automatically; a running HALL game must be restarted by its agent.
* Limits are per IP address and generous so a hall behind one Wi-Fi works (`RATE_LIMIT_PER_MIN`, `AUTH_RATE_LIMIT` in .env).
* Mobile networks are slow: consider raising "claim window" to 8 s in Admin -> Settings (auto-submit is ON by default).
* Bingo-hall console money: of every stack 80% prize, 20% agent commission, of which 4% of the stack is the system share the
  agent owes the company (included in "owes"); jackpot contributions stay in the agent's jackpot fund.

## Agent cash-float settings to check before launch
* Default limits are -1,000 / +100,000 ETB and 5%/5% commission-fee, all editable in Admin -> Settings.
  Decide whether these fit your business before agents start processing real deposits.
* Fund each agent's starting float (Admin -> Agents -> Fund / debit float) before they process their
  first deposit - with a float of 0, the first deposit above about 1,050 ETB (at the default settings)
  will hit the -1,000 floor and be refused.
