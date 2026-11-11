# Player platform - how it works

## Addresses
| Who | Address | Login |
|---|---|---|
| Players | `/player.html` (or `/play`) | phone number + password (self-registration) |
| Agents - cashier | `/cashier` | Agent ID + password (same account as the hall console) |
| Agents - bingo hall console | `/` | Agent ID + password (unchanged) |
| Administrators | `/admin` | username + password |

## Money flow
1. A player registers (unique phone number, unique e-mail, 18+ confirmation).
2. The player gives cash to an **agent**. The agent opens `/cashier`, searches the phone number, deposits.
   The amount is added to the player's wallet. Wrong entry? The agent can **edit** or **cancel** the deposit
   (agent: within 24 h, admin: always). The wallet is corrected by the difference; if the player already spent
   the money the correction is refused with a clear message.
3. The player plays group games (below). Every cartela price is taken from the wallet when the cartela is picked.
4. The player requests a **withdrawal**. The amount leaves the balance immediately (cannot be spent twice) and
   appears in every agent's queue. An agent pays the cash and marks it *Paid* (or *Reject* = money returns to the wallet).
5. Agents hand the collected money to the admin. The admin records the payment in **Agents -> Report / settle**:
   *Payment received - reset to 0*. What an agent owes =
   `deposits collected - withdrawals paid in cash - agent commission - payments already received`.

Every balance change is one row in `wallet_transactions` (ledger). The sum of all balances always equals the sum of the ledger
(this is checked by the automatic tests).

## Group games
* A player creates a game (chooses the cartela price). The **system generates a 6-character Game ID**.
* Others join with the ID. Everybody (host included) picks as many cartelas as they want (up to the admin limit);
  `count x price` is deducted. Removing a cartela before the start refunds it. A cartela can belong to one player only.
* The host presses Start (needs at least 2 players holding cartelas). The **server** draws the numbers (cryptographically
  shuffled, never sent in advance), one every 4 seconds (setting).
* **Auto-mark** (display only) and **Auto-submit** are two independent switches that each player can turn on/off at any time:
  * Auto-submit ON: the system claims BINGO for the player the moment a pattern completes.
  * Auto-submit OFF: the game pauses for 5 seconds and the player must press BINGO. If nobody presses, that pattern is
    lost for that cartela and the game continues (same idea as the hall game).
* **Same-call winners share the prize equally** (whole cents, nothing lost). Default: one share per winning *account*;
  the admin can switch to one share per winning *cartela*.
* Only the winning accounts are credited. Winners come from the cartela ownership stored on the server, never from what a client sends.
* Prize pool = pot - commission % (default 20 %, admin setting; the commission is the platform's income).
* A cancelled game (host leaves / admin cancels / lobby times out / server restarts) **refunds every cartela**.

## Security that is built in
* Passwords hashed (scrypt); reset by **e-mail link** (a password can never be e-mailed because nobody can read it - it is hashed).
* **5 wrong passwords lock the account** for 30 minutes (counted in the database, so changing IP does not help).
  Applies to players, agents and admins. Reset link unlocks.
* Login rate limit per IP, global rate limit per IP, per-socket event limit, max connections per IP, small request/packet size limits,
  slow-connection timeouts: protection against floods and busy-server attacks. (A real DDoS also needs AWS Shield/CloudFront/WAF in front.)
* Signed tokens; disabling an account or changing its password logs the person out at once.
* Strict Content-Security-Policy on the new pages, anti-clickjacking, no-sniff, HSTS behind HTTPS; all texts are inserted as text (no XSS).
* Audit log of every sensitive action (deposit, edit, disable, adjust, settle, settings, ...).
* The old unauthenticated "remote player" endpoints were switched off.

### About "no view source / inspect"
A browser must download the page to show it, so **hiding it 100 % is impossible**. What is done:
1. `shield.js` blocks right-click, F12, Ctrl+U, Ctrl+S, Ctrl+Shift+I/J/C and hides the page when the dev-tools panel opens (deterrent only).
2. `npm run build` creates `dist/` with minified + obfuscated JavaScript (served automatically when `NODE_ENV=production`).
3. **The real protection:** all money, draws, winners and rules run on the server; the browser only displays. Someone who reads
   the page cannot see the draw order, cannot change a balance and cannot claim for another player.

## Admin panel
Overview (money flow, who owes what) - Players (add/edit/disable/enable/unlock/reset password/adjust balance/delete) - Agents
(add/edit/commission %/disable/delete, report per day/week/month, settlement) - Deposits (edit/cancel any) - Withdrawals -
Games (see all, cancel with refund) - Settings - Audit log - Admins.

## Settings (Admin -> Settings)
commission %, split mode, seconds between calls, claim window, min/max players, max cartelas per player, cartela price range,
deposit/withdraw limits, agent edit window, wrong-password limit, lock time.

## Not included yet (recommended before a large public launch)
* **Licensing/legal:** real-money games usually need a licence and terms of service - check Ethiopian rules (not legal advice).
* SMS one-time-password at registration (phone verification), ID/KYC checks, deposit/loss limits and self-exclusion, Amharic translation,
  push notifications, chat in the lobby.
* Scaling beyond one server process (needs Redis for sockets + moving running-game state out of memory).
* Automated MySQL backups (turn on RDS automated backups + test a restore).

## Tests
`npm test` (Node 22+) runs 250+ automatic checks (including random stress tests and attack-input tests) on the real server code against a real SQL engine: wallets, deposits, edit/void,
withdrawals, lockout, password reset, group games (shared prizes, cents, refunds, restarts), agent settlement, hall jackpot/net revenue, joker rules.

## Agent cash-float system (deposits, withdrawals, limits)

Separate from the "bingo-hall business" settlement above, every agent now has their own **cash-float
balance**, shown in Admin -> Agents and in the cashier's My account tab.

- **Limits** (Admin -> Settings): the balance may not go below **-1,000 ETB** (how far into debt an
  agent may go) or above **+100,000 ETB** (how much digital float an agent may hold). Both are
  admin-editable. A deposit or withdrawal that would breach either limit is refused outright -
  nothing is charged to the player and nothing is left half-done.
- **Deposit:** the player's wallet is credited the FULL amount. The agent's own float is drawn down by
  that same full amount, then credited back a commission (default **5%**, Admin -> Settings). Example:
  a 1,000 ETB deposit credits the player 1,000 ETB, and moves the agent's own balance by -1,000 + 50 = -950.
- **Withdrawal:** when an agent marks a request "Paid", the full requested amount moves from the
  player (already held since the request) to the agent's own float balance, and the agent is told the
  **net cash** to hand the player (default **5%** fee kept, Admin -> Settings). Example: for a 1,000 ETB
  request the agent's screen says "pay 950 ETB cash" and their own float balance goes up by 1,000 (the
  950 they paid out plus their 50 ETB fee).
- **The player only ever sees the money they get** - the amount they requested, and once paid, the exact
  cash they received - never a percentage or the agent's cut. Agents and admins see every number: gross
  amount, fee, net, and the agent's own float ledger (Admin -> Agents -> an agent -> own float history;
  cashier -> My account).
- **Editing or cancelling a deposit** also reverses the agent's own float exactly (not just the player's
  wallet), using the commission that was actually charged at the time - not today's rate.
- **Admin -> Agents -> "Fund / debit float"** lets the admin credit an agent (top them up, or record cash
  the agent handed over in person) or debit them, bounded by the same limits.

## Open-games browser

On the player Home tab, "Open games" lists every currently-open public lobby: its game ID, who
hosts it, the cartela price, how many players have joined, and how many cartelas are taken - all
real data from real games. Players can search by game ID or host name and join with one click; the
list refreshes automatically every 5 seconds while that tab is open. A game drops off the list the
moment it starts, is cancelled, or finishes.

Hosts can untick "List this game publicly" when creating a game to keep it invite-only - it still
works exactly the same, players just need the 6-character code from the host rather than finding it
in the browser.
