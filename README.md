# AccessiWeb Engine

AccessiWeb Engine is a TypeScript monorepo starter for AI-assisted accessibility audits and reviewable GitHub remediations.

## Experiences

- **Web URL audit:** Fetches public HTML, optionally analyzes a user-provided screenshot with SAM, produces a structured WCAG report, and can open a GitHub issue.
- **Public repository audit:** Reads bounded sets of HTML, TS/TSX, JSX, Vue, Svelte, and CSS files from a public GitHub repository and reports file/line findings.
- **Private remediation preview:** Requires an Entra ID B2C token, the global `FEATURE_ENABLE_AUTO_PR_PREVIEW` switch, and the user's Cosmos DB preview flag. The GitHub integration creates a branch and pull request with proposed patches and an audit/remediation report.

Reports are stored in Cosmos DB; raw HTML and source file contents are only passed through memory for analysis. Generated changes are proposed in a PR and are not merged automatically.

## Local setup

Requirements: Node.js 22+, npm 10+, and Azure Functions Core Tools v4 to run the API locally.

```sh
npm install
cp apps/web/.env.example apps/web/.env
cp apps/api/local.settings.example.json apps/api/local.settings.json
npm run typecheck
npm test
npm run build
```

Run the frontend with `npm run dev`. Run the API with `npm run start:api` after building the workspace. Configure secrets and service endpoints in the API's local settings or deployment environment; only the `VITE_*` settings belong in the browser app. Never place Meta, GitHub, or Cosmos credentials in Vite environment variables.

The Meta API must provide an OpenAI-compatible `/chat/completions` endpoint with JSON Schema response formatting and image inputs for SAM. Set `META_API_BASE_URL`, `META_API_KEY`, `META_MUSE_CODE_MODEL`, `META_SAM_MODEL`, `META_MUSE_WONDER_MODEL`, and `META_MUSE_IMAGE_MODEL` in the API environment. Set `META_ANALYSIS_PROVIDER=open-weights` with `META_MUSE_SPARK_OPEN_URL` to route repository audits to the configured open-weights endpoint. GitHub issue creation requires `GITHUB_BOT_TOKEN` and an explicit comma-separated `GITHUB_ISSUE_ALLOWED_REPOSITORIES` allowlist using `owner/repo` entries; it is disabled when the allowlist is empty and limited to five issues per repository per minute per Functions worker. Remediation PRs remain separately gated by Entra ID and preview flags. Cosmos containers are created on demand (`scans`, `users`, and `remediations`).

Entra ID B2C configuration uses `ENTRA_B2C_TENANT_NAME`, `ENTRA_B2C_SIGNUP_SIGNIN_POLICY`, `ENTRA_B2C_CLIENT_ID`, and the exact expected `ENTRA_B2C_ISSUER`. The frontend also needs the corresponding `VITE_ENTRA_B2C_*` settings, an optional `VITE_ENTRA_B2C_PROFILE_EDIT_POLICY`, and an API scope if the API is registered as a protected resource. Configure `FEATURE_ENABLE_AUTO_PR_PREVIEW=true` only for an explicitly enabled preview deployment. Set `JUDGE_DEMO_CODE` server-side to the demo code you intend to use; it is never shipped as frontend configuration.

## API routes

- `POST /api/v1/scans/web`
- `POST /api/v1/scans/repo`
- `POST /api/v1/scans/audio-preview`
- `POST /api/v1/github/issues`
- `GET /api/v1/users/me`
- `DELETE /api/v1/users/me/data`
- `POST /api/v1/preview/unlock`
- `POST /api/v1/remediate/pull-request`

The web scanner rejects non-public destinations, revalidates and pins every redirect, limits page size, and never executes the target page. Its automated baseline is static HTML inspection, not axe-core or a rendered browser audit. Screenshots are optional and supplied by the user; they are not persisted. Screenshot bounds are raw image pixels; without CSS viewport/DPR metadata, the engine does not claim WCAG CSS-pixel target-size conformance. Public scans are bounded to 60 source files and 1.5 MB of repository content.

## Scope and deployment

This repository currently provides the app, core service adapters, and local configuration examples. Production deployment still requires provisioning Azure resources, configuring Entra B2C and GitHub permissions, setting rate limits/retention policies, and verifying model endpoint compatibility in the target Meta API account. Review each generated PR before merging.
