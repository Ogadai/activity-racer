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
- **Amazon Cognito:** User Pool (`activity-racer-users`), Managed Login v2 domain, Google OAuth2 identity provider, and public PKCE SPA client (`activity-racer-spa`, no client secret) paired with API Gateway's built-in JWT Authorizer (`event.requestContext.authorizer.jwt.claims.sub`).
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
- **Current contents:** Domain types & API DTOs (`src/types.ts`), weighted daily & Monday–Sunday calendar-week scoring helpers (`src/scoring.ts`), and native Node test suite (`src/scoring.test.ts`).

### 2. `packages/backend` (`@activity-racer/backend`)
- **Purpose:** Serverless Lambda handlers and backend utilities.
- **Design:** Individual handler entry points under `src/handlers/` bundled independently by CDK's `NodejsFunction` (`esbuild`, minified, ARM64) for small cold starts and least-privilege IAM scoping per function.
- **Current handlers:**
  - `src/handlers/health.ts` — `GET /api/health` liveness check returning service name, Region, and timestamp.
  - `src/handlers/ingestStats.ts` — `POST /api/stats` Home Assistant webhook protected by per-player `x-api-key` (constant-time comparison) + `playerSlug`.
  - `src/handlers/player.ts` — `GET /api/me` and `PUT /api/me` (lazy profile initialization, targets/weights validation, atomic `playerSlug` uniqueness, and `webhookApiKey` rotation).
  - `src/handlers/groups.ts` — `GET /api/groups`, `POST /api/groups`, and `POST /api/groups/join` (transactional group creation & invite-code joining).
  - `src/handlers/race.ts` — `GET /api/groups/{groupId}/race?range=daily|weekly&date=YYYY-MM-DD` (membership-checked daily & Monday–Sunday weekly leaderboards).
  - `src/handlers/spa.ts` — Option B3 static SPA server reading from the private frontend S3 bucket with path-traversal guards, `/api/*` 404 isolation, MIME/binary handling, immutable caching for `/assets/*`, `no-store` for `index.html`/`config.json`, and extensionless SPA fallback to `index.html`.

### 3. `packages/frontend` (`@activity-racer/frontend`)
- **Purpose:** Static Single Page Application built with React 19, Vite, React Router, TanStack Query, and TypeScript.
- **Design:**
  - Loads `/config.json` at runtime (`src/config.ts`) so the same built bundle adapts automatically to each deployment's API URL and Cognito IDs without rebuilding.
  - Supports `VITE_*` overrides in a gitignored `packages/frontend/.env.local` file for local `vite dev` (see [Local Frontend Development](#local-frontend-development) below).
  - Implements OAuth 2.0 Authorization Code + PKCE (`S256`) with `state`/`nonce` checks, silent token refresh, and full `/oauth2/revoke` + `/logout` sign-out (`src/auth/cognitoOAuth.ts`).
- **Current UI (Phase 3):** `/login` ("Continue with Google"), `/auth/callback`, `/groups` (create/join + copy invite codes), `/settings` (profile, fair handicapping targets/weights, webhook API key management, and copyable Home Assistant YAML), and `/race` (wired leaderboard table with 30s auto-polling).
- **Planned additions (Phase 4):** Visual cycling race track UI with positioned bikes, 100% finish line, overdrive badges, and expandable stat breakdowns.

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

## Local Frontend Development

In AWS, CDK generates and deploys `/config.json` automatically alongside the SPA. When running Vite locally (`http://localhost:5173`), `/config.json` does not exist, so you provide the deployed stack's **public** endpoints and Cognito identifiers via a gitignored `.env.local` file:

1. Copy the template file:
   ```bash
   cp packages/frontend/.env.example packages/frontend/.env.local
   ```
   *(On Windows PowerShell: `Copy-Item packages\frontend\.env.example packages\frontend\.env.local`)*
2. Open `packages/frontend/.env.local` and fill in the values from your `ActivityRacerStack` CDK deploy outputs (or from your deployed site's `/config.json`):
   - `VITE_API_URL` ← `ApiUrl`
   - `VITE_AWS_REGION` ← `eu-north-1`
   - `VITE_USER_POOL_ID` ← `UserPoolId`
   - `VITE_USER_POOL_CLIENT_ID` ← `UserPoolClientId`
   - `VITE_COGNITO_DOMAIN` ← `CognitoDomain`
   - `VITE_GOOGLE_AUTH_ENABLED` ← `true` (once Google IdP is configured in Cognito)
3. Start the local dev server:
   ```bash
   npm run dev:frontend
   ```
   Open `http://localhost:5173`. Both `http://localhost:5173/auth/callback` and `http://localhost:5173/login` are pre-registered on the Cognito SPA client, so **Continue with Google** works locally as well as in AWS.

> **Security note:** Never place secrets (such as your Google OAuth Client Secret or Home Assistant webhook keys) in `.env.example`, `.env.local`, or `cdk.json`. All `VITE_*` variables above are public browser identifiers. If you tear down and redeploy the stack (`npm run cdk:destroy` → `npm run cdk:deploy`), update `.env.local` with the newly generated stack outputs.

---

## Google OAuth2 Setup (Cognito Federation)

To enable **Continue with Google** on a fresh deployment without storing secrets in git or CloudFormation:

1. Deploy the stack first (`npm run cdk:deploy`) to provision the Cognito Managed Login domain and print `GoogleJavaScriptOrigin` and `GoogleRedirectUri` in the CDK outputs.
2. In **Google Cloud Console → APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** (type **Web application**) using the printed `GoogleJavaScriptOrigin` and `GoogleRedirectUri` (`https://<cognito-domain>/oauth2/idpresponse`).
3. In the **AWS Management Console → Amazon Cognito** (`eu-north-1`) → your User Pool → **Social and external providers**, add **Google** with your Client ID, Client Secret, scopes `openid email profile`, and attribute mappings:
   - `email` → `email`
   - `email_verified` → `email_verified`
   - `name` → `name`
4. Ensure `"enableGoogleAuth": "true"` is set under `"context"` in `packages/infra/cdk.json` (or pass `-c enableGoogleAuth=true`) and run `npm run cdk:deploy`.

---

## Common Commands

> **Windows PowerShell note:** If PowerShell's execution policy blocks `npm.ps1`, use `npm.cmd` instead of `npm`.

```bash
# Install all workspace dependencies
npm install

# Typecheck all packages (shared, backend, frontend, infra)
npm run typecheck

# Run unit tests
npm run test

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
