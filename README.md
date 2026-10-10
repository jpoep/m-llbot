# 🧹 Müllbot

Telegram bot that reminds a shared flat of its recurring chores – and gets increasingly unbearable
towards midnight until they are done.

## How it works

- **Tasks** have a fixed cadence (days, weeks, months, years).
  - *Rotating* tasks are distributed round-robin between all participants.
  - *Joint* tasks (`gemeinsam`) are due for everyone; whoever ticks one off clears it for all.
- **08:00** – everyone gets a digest with what is due today (and tomorrow).
- **From 18:00** – escalating reminders. After each one the bot waits a fixed fraction of the
  time left until midnight. Gaps start at a few hours and shrink geometrically down to one message
  per minute right before midnight. The fraction is set per task with the *annoyance* dial
  (0–10). Preview any level with `/vorschau 7` in Telegram or `bun run preview 7` locally.

  | Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | Messages per evening | 0 | 7 | 9 | 13 | 17 | 24 | 32 | 42 | 55 | 72 | 92 |

- **Missed a day?** The task is due again the next day (regardless of cadence), the annoyance rises
  by 2 per missed day, and every other participant gets a 🃏 **joker** against the culprit.
- **Jokers**: when it's your turn on that task, play a joker and the culprit has to do it instead.
  You can play it any time before 12:00 on the due day, including days in advance. The rotation
  then continues as if you had done it.
- **Take over** (`/uebernehmen`): do someone else's turn voluntarily. No reward.
- **Vacation** (`/urlaub 20.12. 03.01.`): has to be approved by someone else and can be cancelled.
  Your turns go to the others (no jokers); joint tasks are postponed until everyone is back.

Global knobs (times, joker cutoff, boost per miss, …) live in [`src/settings.ts`](src/settings.ts).

## Architecture

```
Telegram ──webhook──▶ Lambda Function URL ──▶ λ muellbot-webhook ─┐
EventBridge Scheduler (every minute) ───────▶ λ muellbot-tick ────┼──▶ DynamoDB (1 item)
                                                                   └──▶ Telegram Bot API
```

| Piece | Why | Cost |
|---|---|---|
| Lambda (arm64, Node 24, Bun-built bundle) | no native Bun runtime on Lambda; a bundled Node build has the fastest cold start | free tier (1M req / 400k GB-s) |
| Function URL | API Gateway isn't needed for one webhook | free |
| EventBridge Scheduler, `cron(* * * * ? *)` | ~43k invocations/month | free tier (14M) |
| DynamoDB, provisioned 3 RCU/3 WCU, one JSON document with optimistic locking | stays in the always-free 25 RCU/WCU | free |
| CloudWatch Logs, 14-day retention | | ≈ €0.00–0.05 |

### Code layout

- `src/domain/` – pure domain logic. Every action is an `Effect` that turns the state into a new
  state plus an outbox of messages, so it's fully testable without I/O.
  - `annoyance.ts` – escalation curve + preview
  - `schedule.ts` – rotation, vacation substitution, projections
  - `actions.ts` – complete, take over, jokers, vacation, task admin
  - `tick.ts` – midnight rollover (punishment), morning digest, evening reminders
  - `views.ts`, `texts.ts`, `commands.ts`, `callbacks.ts` – German UI
- `src/services/` – Effect services: `StateStore` (DynamoDB / in-memory), `Telegram`,
  `Household.transact` (load → apply → save with optimistic locking → deliver)
- `src/bot/bot.ts` – grammY command and button routing
- `src/lambda.ts` – Lambda handlers
- `infra/` – Pulumi program

## Development

```sh
bun install
bun run check      # tsc + biome + bun test
bun run preview    # reminder cadence for all annoyance levels
```

## Deployment

Prerequisites: AWS credentials for the workload account (`342560106494`; the stack refuses any
other account) and a bot token from [@BotFather](https://t.me/BotFather).

```sh
cd infra
pulumi config set --secret telegramBotToken '<token from BotFather>'
# joinCode is already set; rotate it with: pulumi config set --secret joinCode "$(openssl rand -hex 12)"
cd ..
bun run deploy     # check → build → pulumi up → set webhook + command menu, prints the invite link
```

Share the printed invite link (`https://t.me/<bot>?start=<joinCode>`) only with your roommates.
Anyone who knows it can join the household.

## Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` runs `bun run check` on every push and PR. Pushes to `main` then run
`pulumi up` and refresh the Telegram webhook/commands.

- **AWS:** OIDC, no stored keys. The role `muellbot-github-deploy` only trusts
  `repo:jpoep/m-llbot:environment:production` (audience `sts.amazonaws.com`). The `production`
  environment only accepts the `main` branch. The role can manage the bot's `muellbot-*`
  resources but can only *read* its own role and policy, so changes to it have to be deployed
  locally with admin credentials.
- **Pulumi Cloud:** repository secret `PULUMI_ACCESS_TOKEN`.

One-time bootstrap:

1. Run a local `bun run deploy` (creates the deploy role). If the account has no GitHub OIDC
   provider yet: `pulumi config set createGithubOidcProvider true --cwd infra`.
2. `gh secret set PULUMI_ACCESS_TOKEN --env production` with a token from
   https://app.pulumi.com/account/tokens
3. `gh variable set DEPLOY_ENABLED --body true`

The repository is public, so CI never prints the invite link.

## Commands (German)

`/heute` `/plan` `/erledigt` `/uebernehmen` `/joker` `/urlaub` `/punkte` `/aufgaben`
`/neu Name | Rhythmus | gemeinsam | ab Datum` `/rhythmus Nr | Rhythmus` `/termin Nr | Datum`
`/nervig` `/vorschau 0–10` `/loeschen` `/hilfe`
