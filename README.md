# Activity Racer

A gamified fitness tracking web application where family and friends sign up, create or join groups via invite codes, automatically sync daily activity stats (steps and active calories) from **Home Assistant** via an HTTP POST webhook, and view daily/weekly progress as a visual race (bikes on a track).

To keep races fair across ages and abilities (for example, an adult vs. a 13-year-old), each player configures personal daily targets and metric weights so track progress is plotted as a normalized percentage of their personal goal.

> See [ProjectPlan.md](./ProjectPlan.md) for the phased roadmap, checklist, and implementation progress.

---

## Architecture Overview

Activity Racer is built on AWS serverless services designed for **$0 idle cost** and clean dev teardown (`RemovalPolicy.DESTROY`, `autoDeleteObjects: true`), deployed strictly in **`eu-north-1`**:

- **Amazon API Gateway (HTTP API):** Serves backend endpoints under `/api/*` (to prevent path collisions with React Router SPA routes).
- **AWS Lambda (TypeScript, Node.js 22, ARM64):** Handles API logic and Home Assistant webhook ingestion, bundled locally with `esbuild`.
- **Amazon DynamoDB (On-Demand):** Single-table store (`PK`/`SK` + `GSI1`) for player profiles, groups, memberships, and daily activity stats.
- **Amazon Cognito (Phase 2):** User Pool authentication paired with API Gateway's built-in JWT Authorizer (`event.requestContext.authorizer.jwt.claims.sub`).
- **Amazon S3 (Private) + SPA Hosting:** Built Vite assets and a CDK-generated runtime `/config.json` are stored in a private S3 bucket:
  - **Default (Option B3):** Served over HTTPS via a lightweight read-only `SpaHostingFunction` Lambda (`GET /`, `GET /{proxy+}`) on the existing HTTP API Gateway while CloudFront project verification is pending.
  - **CloudFront OAC:** Enable with `-c enableCloudFront=true` to place a CloudFront distribution with Origin Access Control in front of the private S3 bucket (using 403/404 → `/index.html` error responses for SPA routing, with no Lambda@Edge).

---

## Monorepo Package Design

The repository uses **npm workspaces** (`packages/*`) with shared strict TypeScript settings in `tsconfig.base.json`:

```text
activity-racer/
├── package.json              # Root workspace config & orchestration scripts
├── tsconfig.base.json        # Shared strict TypeScript compiler options
├── ProjectPlan.md            # Phased roadmap and progress checklist
└── packages/
    ├── shared/               # @activity-racer/shared
    ├── backend/              # @activity-racer/backend
    ├── frontend/             # @activity-racer/frontend
    └── infra/                # @activity-racer/infra
```

### 1. `packages/shared` (`@activity-racer/shared`)
- **Purpose:** Single source of truth for domain types, API request/response DTOs, and pure scoring/handicapping math shared between Lambda and React.
- **Design:** Exports TypeScript directly from `src/index.ts` so Vite and CDK's `esbuild` bundler consume it with zero intermediate build step.
- **Current contents:** `HealthResponse` and `RuntimeConfig` contracts (`src/types.ts`).
- **Planned additions (Phase 2):** Group, Player, DailyStat, RaceStanding DTOs, and weighted daily/weekly progress calculations (`src/scoring.ts`).

### 2. `packages/backend` (`@activity-racer/backend`)
- **Purpose:** Serverless Lambda handlers and backend utilities.
- **Design:** Individual handler entry points under `src/handlers/` bundled independently by CDK's `NodejsFunction` (`esbuild`, minified, ARM64) for small cold starts and least-privilege IAM scoping per function.
- **Current handlers:**
  - `src/handlers/health.ts` — `GET /api/health` liveness check returning service name, Region, and timestamp.
  - `src/handlers/spa.ts` — Option B3 static SPA server reading from the private frontend S3 bucket with path-traversal guards, MIME/binary handling, immutable caching for `/assets/*`, `no-store` for `index.html`/`config.json`, and extensionless SPA fallback to `index.html`.
- **Planned handlers (Phase 2):** `ingestStats.ts` (`POST /api/stats` with `x-api-key`), `player.ts` (`GET/PUT /api/me`), `groups.ts` (`POST /api/groups`, `POST /api/groups/join`, `GET /api/groups`), and `race.ts` (`GET /api/groups/{groupId}/race`).

### 3. `packages/frontend` (`@activity-racer/frontend`)
- **Purpose:** Static Single Page Application built with React 19, Vite, and TypeScript.
- **Design:**
  - Loads `/config.json` at runtime (`src/config.ts`) so the same built bundle adapts automatically to each deployment's API URL (and Cognito IDs in Phase 2) without manual `.env` copying.
  - Supports `VITE_API_URL` / `VITE_AWS_REGION` overrides for local `vite dev`.
- **Current UI:** Phase 1 walking skeleton card (`src/App.tsx`) verifying live `/config.json` and `GET /api/health` connectivity.
- **Planned additions (Phases 3–4):** Cognito auth flows, TanStack Query API hooks with Bearer tokens & polling, React Router views (`/login`, `/race`, `/groups`, `/settings`), and the visual cycling race track UI.

### 4. `packages/infra` (`@activity-racer/infra`)
- **Purpose:** AWS CDK (TypeScript) Infrastructure as Code defining a single cohesive `ActivityRacerStack` for reliable deploy and teardown.
- **Design:**
  - `bin/app.ts` pins deployment to `eu-north-1` and fails fast if `AWS_REGION` or `AWS_DEFAULT_REGION` points elsewhere.
  - `lib/activity-racer-stack.ts` provisions DynamoDB (`PK`/`SK` + `GSI1`), API Gateway HTTP API, Lambda functions with explicit 7-day CloudWatch `LogGroup`s (`RemovalPolicy.DESTROY`), private S3 bucket (`BLOCK_ALL`, `enforceSSL: true`, `autoDeleteObjects: true`), `BucketDeployment` (uploading `packages/frontend/dist` + runtime `config.json`), and feature-flagged CloudFront OAC (`-c enableCloudFront=true`).

---

## DynamoDB Single-Table Design (`ActivityRacerTable`)

| Entity | `PK` | `SK` | `GSI1PK` | `GSI1SK` | Purpose |
|---|---|---|---|---|---|
| **Player Profile** | `USER#<cognitoSub>` | `PROFILE` | `SLUG#<playerSlug>` | `USER#<cognitoSub>` | Display name, targets, weights, HA slug lookup |
| **Group** | `GROUP#<groupId>` | `META` | `INVITE#<inviteCode>` | `GROUP#<groupId>` | Group name & invite-code lookup |
| **Membership** | `GROUP#<groupId>` | `MEMBER#<cognitoSub>` | `USER#<cognitoSub>` | `GROUP#<groupId>` | Group roster & "my groups" lookup |
| **Daily Stat** | `USER#<cognitoSub>` | `STAT#<YYYY-MM-DD>` | — | — | Daily steps & active calories upserts from HA |

---

## Common Commands

> **Windows PowerShell note:** If PowerShell's execution policy blocks `npm.ps1`, use `npm.cmd` instead of `npm`.

```bash
# Install all workspace dependencies
npm install

# Typecheck all packages (shared, backend, frontend, infra)
npm run typecheck

# Run frontend locally (optionally set VITE_API_URL in packages/frontend/.env.local)
npm run dev:frontend

# Build frontend and synthesize the CloudFormation template locally
npm run cdk:synth

# Build frontend and deploy to eu-north-1 (Option B3 HTTPS hosting)
npm run cdk:deploy

# Deploy with CloudFront OAC enabled (once unlocked on your AWS project)
npm run build:frontend && npm --workspace=@activity-racer/infra run cdk -- deploy -c enableCloudFront=true

# Tear down all stack resources cleanly
npm run cdk:destroy
```
