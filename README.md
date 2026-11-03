# AccessiWeb Engine

AccessiWeb Engine is a TypeScript monorepo starter for AI-assisted accessibility audits and reviewable GitHub remediations.

## Architecture

```mermaid
flowchart LR
  Browser[React and Vite frontend] -->|HTTPS| Functions[Azure Functions API]
  Functions -->|Managed identity| Cosmos[(Cosmos DB)]
  Functions -->|Key Vault references| Vault[Azure Key Vault]
  Functions -->|Configured model endpoint| Meta[Meta-compatible Model API]
  Functions -->|Scoped bot token| GitHub[GitHub Issues and PRs]
  Functions --> Insights[Application Insights]
  Actions[GitHub Actions] -->|Subscription Bicep deployments| Azure[Azure resource groups]
  Actions -->|Build and deploy| Browser
  Actions -->|Build and deploy| Functions
```

The Azure resources and CI/CD workflows are defined under `infra/bicep` and `.github/workflows`. See [Platform Engineering](docs/PLATFORM_ENGINEERING.md), [Security](SECURITY.md), [Privacy](PRIVACY.md), and the [Hackathon submission draft](docs/HACKATHON_SUBMISSION.md) for deployment and project details.

## Experiences

- **Web URL audit:** Fetches public HTML, optionally analyzes a user-provided screenshot with SAM, produces a structured WCAG report, and can open a GitHub issue.
- **Public repository audit:** Reads bounded sets of HTML, TS/TSX, JSX, Vue, Svelte, and CSS files from a public GitHub repository and reports file/line findings.
- **Private remediation preview:** Requires an Entra ID B2C token, the global `FEATURE_ENABLE_AUTO_PR_PREVIEW` switch, the user's Cosmos DB preview flag, and an allowlisted repository. The API first returns the exact patch plan for review; a short-lived server-signed approval is required to publish that unchanged plan in a verified bot-owned public fork. It never pushes to the upstream repository.

Reports are stored in Cosmos DB; raw HTML and source file contents are only passed through memory for analysis. GitHub issue content is rendered server-side from a saved repository report. Generated changes are not published until a user reviews and approves the exact plan, and are never merged automatically.

## Local setup

Requirements: Node.js 22+, npm 10+, and Azure Functions Core Tools v4 to run the API locally.

```sh
npm install
cp apps/web/.env.example apps/web/.env
cp apps/api/local.settings.example.json apps/api/local.settings.json
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Run the frontend with `npm run dev`. Run the API with `npm run start:api` after building the workspace. Configure secrets and service endpoints in the API's local settings or deployment environment; only the `VITE_*` settings belong in the browser app. Never place Meta, GitHub, or Cosmos credentials in Vite environment variables.

The Meta API must provide an OpenAI-compatible `/chat/completions` endpoint with JSON Schema response formatting and image inputs for SAM. Set `META_API_BASE_URL`, `META_API_KEY`, `META_MUSE_CODE_MODEL`, `META_SAM_MODEL`, `META_MUSE_WONDER_MODEL`, and `META_MUSE_IMAGE_MODEL` in the API environment. Set `META_ANALYSIS_PROVIDER=open-weights` with `META_MUSE_SPARK_OPEN_URL`, the partner's dedicated `META_MUSE_SPARK_OPEN_API_KEY`, and `META_MUSE_SPARK_OPEN_MODEL` to route repository audits to the configured open-weights endpoint; the Meta API key is not used for this route. GitHub issue and remediation writes require `GITHUB_BOT_TOKEN` and an explicit comma-separated `GITHUB_ISSUE_ALLOWED_REPOSITORIES` allowlist using `owner/repo` entries. Issues are created only from saved repository scans and limited to five per repository per hour using Cosmos-backed quotas. Public scans and generated audio/images share a 10/hour per-IP quota; authenticated scans and generated audio/images share a 30/hour per-user quota. Preview remediations have a separate 5/hour per-user quota through the Cosmos `rateLimits` container. Cosmos uses `COSMOS_DB_ENDPOINT` and managed identity outside local development; set `COSMOS_DB_CONNECTION_STRING` for local development. The database is `accessiweb-db`, and its `scans`, `remediations`, `users`, and `rateLimits` containers are initialized on first use.

Entra ID B2C configuration uses `ENTRA_B2C_TENANT_NAME`, `ENTRA_B2C_SIGNUP_SIGNIN_POLICY`, `ENTRA_B2C_CLIENT_ID`, and the exact expected `ENTRA_B2C_ISSUER`. The frontend also needs the corresponding `VITE_ENTRA_B2C_*` settings, an optional `VITE_ENTRA_B2C_PROFILE_EDIT_POLICY`, and an API scope if the API is registered as a protected resource. Configure `FEATURE_ENABLE_AUTO_PR_PREVIEW=true` only for an explicitly enabled preview deployment. `POST /api/v1/users/me/preview-access` requires a valid bearer token and either a server-side `META_PREVIEW_INVITE_CODE` or `previewAccessApproved: true` on the user's Cosmos DB profile. If unset, `META-HACKATHON-2026` is accepted only when `APP_ENV`/`NODE_ENV` is not production; production has no default invite code. The older `/api/v1/preview/unlock` route remains as an alias.

## API routes

- `POST /api/v1/scans/web`
- `POST /api/v1/scans/repo`
- `GET /api/v1/scans/{scanId}/badge.svg`
- `POST /api/v1/scans/audio-preview`
- `POST /api/v1/images/accessibility-placeholder`
- `POST /api/v1/github/issues`
- `GET /api/v1/users/me`
- `DELETE /api/v1/users/me/data`
- `POST /api/v1/users/me/preview-access`
- `POST /api/v1/remediate/pull-request`
- `GET /api/v1/health` (liveness only; it does not check dependencies)

`POST /api/v1/github/issues` accepts a saved repository scan's `scanId`; issue title and body are composed from the stored report on the server. `POST /api/v1/remediate/pull-request` first prepares and returns a `planId` and plan for review; send that exact `approvedPlan`, `planId`, `approvedPatchHash`, and `approvalToken` in a second request to publish. The approval is user/repository-bound and expires after ten minutes.

The web scanner rejects non-public destinations, revalidates and pins every redirect, limits page size, and never executes the target page. Its automated baseline is static HTML inspection, not a rendered browser audit. Screenshots are optional and supplied by the user; they are not persisted. Screenshot bounds are raw image pixels; without CSS viewport/DPR metadata, the engine does not claim WCAG CSS-pixel target-size conformance. Public scans are bounded to 60 source files and 1.5 MB of repository content.

The report Markdown includes an embeddable score badge backed by the public SVG route. Browser tests capture full-page screenshots for all public routes and a mobile workspace viewport, and run axe-core against WCAG 2.2 A/AA/AAA tags. The remediation API persists workflow states (`ingest`, `audit`, `synthesize_patch`, `verify`, `document`, `submit_pr`, `complete` or `failed`) in Cosmos DB; it remains a synchronous request rather than a background job API. Successful PRs include `ACCESSIBILITY_REMEDIATION_REPORT.md` in the repository root.

## Scope and deployment

### Environment variables

| Variable | Runtime | Purpose |
| --- | --- | --- |
| `META_API_KEY`, `META_API_BASE_URL` | API | Meta-compatible model endpoint credentials and URL |
| `META_MUSE_CODE_MODEL`, `META_SAM_MODEL`, `META_MUSE_WONDER_MODEL`, `META_MUSE_IMAGE_MODEL` | API | Model identifiers |
| `META_ANALYSIS_PROVIDER`, `META_MUSE_SPARK_OPEN_URL` | API | Optional repository-audit open-weights route |
| `META_MUSE_SPARK_OPEN_API_KEY`, `META_MUSE_SPARK_OPEN_MODEL` | API | Dedicated partner credentials and model identifier; never reuse the Meta API key |
| `GITHUB_BOT_TOKEN`, `GITHUB_ISSUE_ALLOWED_REPOSITORIES` | API | GitHub write integration and explicit issue allowlist |
| `COSMOS_DB_ENDPOINT` | API | Cosmos endpoint; deployed apps use their system-assigned identity |
| `COSMOS_DB_CONNECTION_STRING` | API local development only | Local Cosmos connection-string fallback |
| `ENTRA_B2C_TENANT_NAME`, `ENTRA_B2C_SIGNUP_SIGNIN_POLICY`, `ENTRA_B2C_CLIENT_ID`, `ENTRA_B2C_ISSUER` | API | JWT validation and B2C sign-in configuration |
| `FEATURE_ENABLE_AUTO_PR_PREVIEW`, `META_ALLOW_AUTONOMOUS_REMEDIATION`, `META_PREVIEW_INVITE_CODE` | API | The global preview gate also controls the autonomous-remediation safety opt-in; local runs default to disabled. The optional invite must not be exposed to the browser |
| `VITE_API_BASE_URL` | Frontend build | API base URL; deployment workflows set this from Bicep output |
| `VITE_ENTRA_B2C_TENANT_NAME`, `VITE_ENTRA_B2C_CLIENT_ID`, `VITE_ENTRA_B2C_SIGNUP_SIGNIN_POLICY`, `VITE_ENTRA_B2C_PROFILE_EDIT_POLICY`, `VITE_ENTRA_B2C_REDIRECT_URI`, `VITE_ENTRA_B2C_API_SCOPE` | Frontend build | Public identity-provider configuration only |

Production deployment still requires configuring Azure credentials, Entra B2C, Meta/GitHub permissions, GitHub environment protection, retention operations, and validating model endpoint compatibility. Review each generated PR before merging; see the linked platform, security, and privacy documentation.
