# Activity Racer — Project Plan

Gamified fitness tracking web application where family and friends sign up, create or join groups via invite codes, automatically sync daily activity stats (steps, active calories) from Home Assistant via webhook, and race each other with fair age/ability handicapping.

## Preferences & AWS Project Context

- **Guidance Level:** `HIGH` (explain what each step does and why, suggest alternatives, flag best practices & trade-offs)
- **AWS Selected Region:** `eu-north-1` (all Regional resources MUST be created in `eu-north-1`; CloudFront is global)
- **Cost & Service Constraints:**
  - Strictly AWS Free Plan / Always-Free serverless services: **API Gateway (HTTP API)**, **AWS Lambda (TypeScript)**, **DynamoDB (on-demand)**, **Cognito (User Pool)**, **S3 + CloudFront**.
  - **No** VPCs, NAT Gateways, RDS, Lambda@Edge, StackSets, or cross-Region resources.
  - All dev resources configured for clean teardown (`RemovalPolicy.DESTROY`, `autoDeleteObjects: true`).

---

## Architecture & Folder Structure (npm Workspaces)

```text
activity-racer/
├── ProjectPlan.md                    # Living project plan & phase checklist
├── package.json                      # Root npm workspaces + convenience scripts
├── tsconfig.base.json                # Shared strict TypeScript compiler options
└── packages/
    ├── shared/                       # Shared domain types & weighted scoring helpers
    │   ├── package.json
    │   └── src/
    │       ├── index.ts
    │       ├── types.ts
    │       └── scoring.ts
    ├── backend/                      # AWS Lambda handlers (TypeScript, esbuild-bundled)
    │   ├── package.json
    │   └── src/
    │       ├── lib/
    │       │   ├── db.ts             # DynamoDB DocumentClient + key helpers
    │       │   ├── auth.ts           # Cognito JWT `sub` claim & `x-api-key` validation
    │       │   └── http.ts           # JSON response & error helpers
    │       └── handlers/
    │           ├── health.ts         # Phase 1: GET /health
    │           ├── ingestStats.ts    # Phase 2: POST /stats (Home Assistant webhook)
    │           ├── player.ts         # Phase 2: GET/PUT /me
    │           ├── groups.ts         # Phase 2: POST /groups, POST /groups/join, GET /groups
    │           └── race.ts           # Phase 2: GET /groups/{groupId}/race
    ├── frontend/                     # React + Vite + TypeScript static SPA
    │   ├── package.json
    │   ├── index.html
    │   ├── vite.config.ts
    │   └── src/
    │       ├── main.tsx
    │       ├── config.ts             # Loads runtime `/config.json` deployed by CDK
    │       ├── api/                  # Fetch wrapper (attaches JWT) + TanStack Query hooks
    │       ├── auth/                 # Cognito auth integration
    │       ├── components/           # RaceTrack, NavBar, ProtectedRoute
    │       └── pages/
    │           ├── LoginPage.tsx
    │           ├── RacePage.tsx      # Live Race / Leaderboard view
    │           ├── GroupsPage.tsx    # Create / Join Group view
    │           └── SettingsPage.tsx  # Daily targets, weighting & HA webhook setup
    └── infra/                        # AWS CDK (TypeScript)
        ├── package.json
        ├── cdk.json
        ├── bin/
        │   └── app.ts                # Explicitly pinned to `eu-north-1`
        └── lib/
            └── activity-racer-stack.ts
```

---

## DynamoDB Single-Table Schema (`ActivityRacerTable`)

- **Billing Mode:** `PAY_PER_REQUEST` (on-demand)
- **Keys:** `PK` (String), `SK` (String)
- **GSI1:** `GSI1PK` (String), `GSI1SK` (String), `ProjectionType.ALL`

| Entity | `PK` | `SK` | `GSI1PK` | `GSI1SK` | Key Attributes |
|---|---|---|---|---|---|
| **Player Profile** | `USER#<cognitoSub>` | `PROFILE` | `SLUG#<playerSlug>` | `USER#<cognitoSub>` | `displayName`, `playerSlug`, `bikeColor`, `dailyStepTarget` (default `10000`), `dailyCalorieTarget` (default `500`), `stepWeight` (`0.5`), `calorieWeight` (`0.5`), `createdAt` |
| **Group** | `GROUP#<groupId>` | `META` | `INVITE#<inviteCode>` | `GROUP#<groupId>` | `groupId`, `name`, `inviteCode`, `createdBy`, `createdAt` |
| **Membership** | `GROUP#<groupId>` | `MEMBER#<cognitoSub>` | `USER#<cognitoSub>` | `GROUP#<groupId>` | `role` (`OWNER` \| `MEMBER`), `joinedAt` |
| **Daily Stat** | `USER#<cognitoSub>` | `STAT#<YYYY-MM-DD>` | — | — | `date`, `steps`, `activeCalories`, `updatedAt`, `source` |

### Fair Weighting Formula
- Daily normalized score per player:
  - `stepPct = steps / dailyStepTarget`
  - `calPct = activeCalories / dailyCalorieTarget`
  - `weightedScorePct = (stepWeight * stepPct + calorieWeight * calPct) * 100`
- Weekly view aggregates each player's daily weighted scores across the 7-day window so personal targets remain fairly normalized day-by-day.

---

## Phased Implementation Plan

### Phase 1: Walking Skeleton (Deploy & Teardown Verification)
- [x] Verify AWS CLI credentials, `eu-north-1` Region, and project plan state (`aws freetier get-account-plan-state`)
- [x] Initialize monorepo root (`package.json`, `tsconfig.base.json`, `.gitignore`)
- [x] Scaffold `packages/shared`, `packages/backend` (`GET /health`), `packages/frontend` (Vite + React placeholder), and `packages/infra` (CDK TypeScript stack)
- [x] CDK stack provisions:
  - DynamoDB table (`PK`/`SK` + `GSI1`, `RemovalPolicy.DESTROY`)
  - API Gateway HTTP API (`/api/*` backend routes to prevent collisions with React Router paths) + `GET /api/health` Lambda (`NODEJS_22_X`, `ARM_64`, explicit LogGroup with `RemovalPolicy.DESTROY`)
  - Private S3 bucket (`RemovalPolicy.DESTROY`, `autoDeleteObjects: true`) + feature-flagged CloudFront OAC (`-c enableCloudFront=true` once AWS Support unlocks CloudFront) with temporary Option B3 HTTPS SPA Lambda hosting (`GET /` and `GET /{proxy+}`)
  - `BucketDeployment` uploading built `frontend/dist` + runtime `config.json`
- [x] Build frontend and validate with `cdk synth`
- [ ] Run `cdk bootstrap` (if needed in `eu-north-1`) and `cdk deploy`
- [ ] Verify live CloudFront URL renders placeholder app and displays live `GET /health` response
- [ ] Run `cdk destroy` to verify clean zero-leftover teardown

### Phase 2: Cognito Auth, Data Model & API
- [ ] Add Cognito User Pool (email/password; structured for Google federation later) + public SPA User Pool Client in CDK; expose IDs in `config.json`
- [ ] Attach API Gateway HTTP API JWT Authorizer (`HttpUserPoolAuthorizer`) to authenticated routes
- [ ] Implement shared domain types & weighted scoring logic + unit tests in `packages/shared`
- [ ] Implement Lambda endpoints:
  - `POST /stats` (`x-api-key` protected Home Assistant webhook)
  - `GET /me`, `PUT /me` (player profile, targets, weighting, `playerSlug`)
  - `POST /groups`, `POST /groups/join`, `GET /groups`
  - `GET /groups/{groupId}/race?range=daily|weekly&date=YYYY-MM-DD`
- [ ] Deploy and verify endpoints (including simulated Home Assistant `POST /stats`)

### Phase 3: Frontend Auth, Routing & Group Management
- [ ] Integrate Cognito sign-up, email confirmation, sign-in, sign-out, and protected routes
- [ ] Wire `@tanstack/react-query` API client with Cognito Bearer JWT headers & polling
- [ ] Build React Router pages: `/login`, `/groups`, `/settings` (with copyable Home Assistant YAML), and `/race` (wired table placeholder)

### Phase 4: Gamified Race UI
- [ ] Build visual Race Track component (bikes on track positioned by weighted %, 100% finish line, overdrive >100% badge)
- [ ] Daily vs. Weekly toggle, date selector, auto-refresh status
- [ ] Highlight logged-in user and current leader + expandable raw-vs-weighted stat breakdown
- [ ] Mobile-responsive polish and final deployment verification
