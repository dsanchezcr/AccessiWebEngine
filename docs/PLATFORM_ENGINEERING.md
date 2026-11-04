# Platform engineering and deployment

This repository provisions the web app, Functions API, Cosmos DB, Key Vault, and telemetry resources with subscription-scoped Bicep. GitHub Actions can create isolated PR resource groups and promote builds through staging, QA, and production.

## Prerequisites

- An Azure subscription with permission to create resource groups, resources, and role assignments.
- Azure CLI with Bicep support, GitHub Actions enabled, and a GitHub repository environment for each permanent tier.
- A Meta API key and a GitHub bot token with only the repository permissions needed for the configured issue/PR workflows.
- Entra ID B2C application values if sign-in and private remediation are enabled.

## GitHub-to-Azure credentials

Create a service principal scoped to the subscription. The Owner role is used because deployments create role assignments for the Function App identity and Key Vault secret access; it is broad and should be dedicated to this deployment, protected as a GitHub secret, and rotated.

```sh
az ad sp create-for-rbac --name "sp-accessiweb-cicd" --role Owner --scopes /subscriptions/<SUBSCRIPTION_ID> --sdk-auth
```

Save the complete JSON output as the GitHub Actions secret `AZURE_CREDENTIALS`. The `deploymentPrincipalId` Bicep parameter is the service principal's **object ID**, not its client/application ID. Find it with:

```sh
az ad sp show --id <CLIENT_ID> --query id --output tsv
```

Set that value as the GitHub Actions variable `AZURE_DEPLOYMENT_PRINCIPAL_ID`. The Key Vault module grants this principal the Secrets Officer role at the newly provisioned vault so it can write the initial secrets. The Functions system-assigned identity receives Key Vault Secrets User and Cosmos DB Built-in Data Contributor roles.

> `--sdk-auth` is retained to match the Azure CLI output accepted by `azure/login@v2`; if your installed CLI no longer supports it, use its supported JSON-auth output and confirm that it contains `clientId`, `clientSecret`, `subscriptionId`, and `tenantId`.

## GitHub secrets and variables

Configure these repository secrets (or environment secrets for permanent tiers):

| Secret | Purpose |
| --- | --- |
| `AZURE_CREDENTIALS` | Service-principal JSON consumed by `azure/login@v2` |
| `META_API_KEY` | Server-side Meta API authentication; stored in Key Vault by deployment |
| `META_MUSE_SPARK_OPEN_API_KEY` | Dedicated partner authentication for optional open-weights analysis; stored in Key Vault |
| `BOT_TOKEN` | Server-side GitHub issue/remediation integration token; stored in Key Vault |
| `META_PREVIEW_INVITE_CODE` | Optional shared preview invite; stored in Key Vault when set |

GitHub Actions secret names cannot start with `GITHUB_`. Create `BOT_TOKEN` at repository scope for PR deployments and in each permanent environment as needed. Deployment maps it to the API's existing `GITHUB_BOT_TOKEN` runtime setting through Key Vault.

Open-weights analysis requires its own partner API key, URL, and model identifier. Configure `META_MUSE_SPARK_OPEN_API_KEY`, `META_MUSE_SPARK_OPEN_URL`, and `META_MUSE_SPARK_OPEN_MODEL` together before selecting `META_ANALYSIS_PROVIDER=open-weights`; do not reuse `META_API_KEY` for the partner endpoint.

Set the following Actions variables at repository scope for PR deployments and separately in each `staging`, `qa`, and `prod` environment:

| Variable | Purpose |
| --- | --- |
| `AZURE_DEPLOYMENT_PRINCIPAL_ID` | Service principal object ID used for Key Vault role assignment |
| `META_API_BASE_URL` | `https://api.meta.ai/v1` for Meta-hosted scans; the official root `https://api.meta.ai` is also normalized to `/v1` |
| `META_ANALYSIS_PROVIDER` | `meta` or `open-weights` |
| `META_MUSE_SPARK_OPEN_URL` | Optional open-weights endpoint |
| `META_MUSE_SPARK_OPEN_MODEL` | Partner model identifier; required when open-weights analysis is selected |
| `META_MUSE_CODE_MODEL` | Audit, screenshot interpretation, and remediation model; defaults to `muse-spark-1.3` |
| `META_MUSE_WONDER_MODEL`, `META_MUSE_IMAGE_MODEL` | Optional audio/image helper model identifiers; require separately compatible capabilities |
| `ISSUE_ALLOWED_REPOSITORIES` | Comma-separated `owner/repo` issue-write allowlist; mapped to the API's `GITHUB_ISSUE_ALLOWED_REPOSITORIES` runtime setting |
| `ENTRA_B2C_TENANT_NAME` | B2C tenant short name |
| `ENTRA_B2C_CLIENT_ID` | Client/application ID |
| `ENTRA_B2C_POLICY_NAME` | Sign-up/sign-in policy |
| `ENTRA_B2C_ISSUER` | Exact JWT issuer expected by API verification |
| `VITE_ENTRA_B2C_API_SCOPE` | API scope requested by the frontend |
| `FEATURE_ENABLE_AUTO_PR_PREVIEW` | `true` only for environments where preview remediation is deliberately enabled |
| `META_ALLOW_AUTONOMOUS_REMEDIATION` | Set with the preview feature gate; false by default in local settings |

The workflows deploy to Azure only for same-repository PRs; fork PRs still run validation but do not receive Azure credentials or secrets. Protect `main` and restrict who can edit Actions secrets and environment variables. Configure GitHub environment protection rules, especially required reviewers for `prod` (and optionally `qa`).

## Bicep architecture

`infra/bicep/main.bicep` is subscription-scoped and creates:

- `rg-accessiweb-pr-<number>` for a PR, or `rg-accessiweb-{staging,qa,prod}` for a permanent tier.
- `modules/monitoring.bicep`: Log Analytics and workspace-based Application Insights.
- `modules/keyvault.bicep`: RBAC-enabled Key Vault and initial Meta/GitHub secrets.
- `modules/cosmosdb.bicep`: `accessiweb-db`, the four partitioned containers, serverless non-production accounts, production autoscale, and the connection string secret.
- `modules/functionapp.bicep`: Linux Node.js 22 Functions on the Y1 plan, storage, managed identity, role grants, Key Vault references, and Static Web App-origin-locked CORS.
- `modules/staticwebapp.bicep`: Free SKU for PR/staging and Standard for QA/production.

Validate the templates without deploying:

```sh
az bicep build --file infra/bicep/main.bicep --stdout
```

For a manual deployment, first sign in with an identity authorized to deploy at subscription scope and create role assignments. Pass secrets through a secure shell/session; do not check them into parameter files or print them in logs:

```sh
az deployment sub create \
  --name deploy-accessiweb-staging \
  --location eastus2 \
  --template-file infra/bicep/main.bicep \
  --parameters environment=staging \
    deploymentPrincipalId="<SERVICE_PRINCIPAL_OBJECT_ID>" \
    metaApiKey="<META_API_KEY>" \
    githubBotToken="<BOT_TOKEN>" \
    metaPreviewInviteCode="<OPTIONAL_PREVIEW_CODE_OR_EMPTY>" \
    metaApiBaseUrl="<META_API_BASE_URL>"
```

The Bicep Function App uses a system-assigned identity for Cosmos access in all deployed environments. Local development may instead use `COSMOS_DB_CONNECTION_STRING`; do not add that setting to a deployed Function App. Production sets `APP_ENV=production`, preventing the non-production default preview invite code.

## Workflow behavior

- `.github/workflows/pr-ephemeral.yml` runs typecheck, unit and Playwright/axe tests, builds, and Bicep compilation. Playwright screenshot and trace artifacts are uploaded for the verification job. For same-repository PRs it deploys an isolated Azure resource group, publishes the API and frontend, verifies CORS and `/api/v1/health`, and posts preview URLs. The frontend URL comes from the upload action's `static_web_app_url` output, not Bicep's default hostname. The same URL appears in the run summary and GitHub environment link. On PR close it requests asynchronous resource-group deletion.
- `.github/workflows/cd-pipeline.yml` validates once, including browser accessibility tests and screenshot artifact upload, then calls the reusable `.github/workflows/deploy-stage.yml` for `staging`, `qa`, and `prod` in sequence. GitHub environment rules provide the approval gates.
- `.github/workflows/codeql.yml` analyzes JavaScript/TypeScript on pushes, PRs, a weekly schedule, and manual dispatch. `.github/workflows/dependency-review.yml` checks PR dependency changes, while `.github/dependabot.yml` schedules npm and GitHub Actions updates.
- Each environment deployment creates or updates its resources from Bicep before deploying application artifacts. The frontend build receives the deployed Function URL and copies `staticwebapp.config.json` into the SWA artifact.

Bicep allows the environment's default Static Web App origin. After uploading the frontend, both deployment workflows run `.github/scripts/configure-web-origin.sh` to add the actual deployed origin, retaining the default origin. This covers Azure's PR preview hostname (which differs from the default hostname) and permanent staging/QA/production deployments without allowing `*` or other environments. The script checks POST preflights requesting `content-type` and `authorization` from both origins and publishes the frontend and API health links to the workflow summary. A missing deployment URL or failed preflight fails the job; it never falls back to an incorrect frontend link.

The API is compiled locally in CI and packaged as a self-contained `.artifacts/api` directory with `host.json`, the compiled API/shared/engine tree, and locked production dependencies. Both deployment workflows smoke-test the package without resolving dependencies from the checkout, then deploy it without a remote build. Deployment credentials and model configuration are scoped to deployment steps rather than inherited by unit tests.

The automated checks include TypeScript typechecks, Node tests, Playwright screenshots and axe-core checks on public pages and the mobile workspace, production builds, Bicep compilation, and an API health check. The browser checks are a regression aid, not proof of complete WCAG conformance; manual keyboard and assistive-technology testing is still required. There is no dedicated ESLint script.

The promotion workflow is restricted to `main` for both pushes and manual dispatch. Set each GitHub environment's deployment-branch rule to `main` as an additional protection, and require production reviewers.

## Operational notes

- The API health endpoint is a liveness response; it does not prove that Cosmos DB, Meta, or GitHub are reachable.
- PR resource deletion uses `--no-wait`. Verify the resource group is deleted after workflow completion if Azure deletion is delayed.
- Resource names are deterministic within each resource group and globally unique where Azure requires it.
- The templates use public service endpoints with HTTPS, CORS restrictions, managed identity, RBAC, and app-level controls. They do not provision private endpoints, a VNet, a WAF, or a customer-managed encryption key.
- Validate the current Azure region/SKU availability and quota before a production rollout.

## Scan limits and troubleshooting

Repository audits and remediation preview accept at most **60 supported files** totaling **1.5 MB (1,500,000 UTF-8 bytes)** on the selected/default branch. Supported extensions are `.html`, `.htm`, `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`, and `.css`; other files do not count. GitHub-truncated trees are rejected. Exceeding either limit returns **413**, not a partial audit. Files are read by their pinned Git blob SHA so GitHub's Contents API 1 MB inline-content limit does not silently omit otherwise supported files. Only the first **20,000 characters of each file** are sent to the model. The repository form and How it works page show these limits. Use a smaller public repository or analyze its deployed web page instead.

Web audits accept HTML up to **5 MB (5,000,000 bytes)**, **3 redirects**, and **15 seconds per target request**. The size limit applies to the HTML response, including inline scripts/styles/data, not the combined size of a modern website's assets. Linked images, JavaScript, fonts, and stylesheets are not downloaded. Every destination is validated and DNS-pinned; public IPv4 is preferred when both address families are present because Linux Functions may lack outbound IPv6. Private/special-purpose addresses remain blocked even when mixed with public DNS answers.

The AI input is reduced independently of the download limit: script elements and comments are removed, and data URL attribute payloads are replaced with placeholders. The remaining original markup, including accessibility defects, is preserved rather than reserialized from a repaired DOM. Only the first **100,000 remaining HTML characters** are sent to the model. If more remains, the model receives coverage metadata and the server prefixes the saved report summary with a partial-review warning; its score is not a full-page assessment. Static baseline counts still cover the fetched source, but the heading-level sample is limited to 100 entries with an explicit truncation flag.

Web analysis uses one **120-second model deadline**, shared across optional screenshot interpretation, HTML analysis, and retry backoff. A slow completion can run beyond 30 seconds without being discarded and restarted. Quick connection failures, HTTP 429, and upstream 5xx responses can retry up to three attempts within that deadline; an expired/aborted model request is not retried. Other model operations share a **90-second deadline per operation**, replacing three independent 30-second attempt windows. For interactive web scans on the official Meta endpoint with `muse-spark-1.3`, the client sends documented [`reasoning_effort: "low"`](https://dev.meta.ai/docs/reasoning) to reduce reasoning latency. Custom model IDs and partner endpoints do not receive that compatibility-sensitive field. This is still a synchronous API, not a background job; do not keep increasing timeouts beyond the hosting/proxy response window.

Target connection/TLS failures return **502** and target timeouts return **504** with a message in the scan form. Model request rejection or invalid model reports return **502**; unavailable or unconfigured analysis returns **503**, and model timeouts return **504**. Repository open-weights routing does not change the Meta endpoint used by web scans.

For **AI timeouts or 502/504 errors**:

1. Inspect the failed scan request's response body in the browser Network panel, not just the status code. An AI deadline error means the target fetch completed; the 15-second fetch timeout and HTML size limit are separate. An oversized HTML document returns **413**, not 502/504.
2. Correlate the failure with Application Insights stages and safe model error codes described below. A model `request_failed` or `invalid_response` 502 needs endpoint/model/schema investigation; more fetch time will not fix it. A target connection 502 instead needs public reachability/TLS investigation.
3. If the response is an HTML gateway error rather than the API's JSON error, investigate the Function/proxy request duration and availability. The frontend reports these errors without exposing a JSON parse exception. Verify that the deployed frontend uses the Function's `/api` base URL rather than an unintended additional proxy with a shorter timeout.
4. Deploy the updated client and input-reduction code through the normal promotion pipeline, then scan a small public page without a screenshot and retry the affected pages. Test screenshots separately. A successful health check does not exercise inference, quotas, or report persistence.
5. If inference still exceeds the deadline, check model availability and quotas and compare a small structured-output request using the same model and server-side credentials. Do not publish credentials, raw HTML, or model response bodies in troubleshooting logs. Avoid repeated browser retries while an earlier scan is still running.

For **"The AI analysis service rejected the scan"** on Meta-hosted deployments:

1. Set `META_API_BASE_URL=https://api.meta.ai/v1`. The client appends `/chat/completions`; Meta serves this at `/v1/chat/completions`, not `/chat/completions`. Updated clients normalize `https://api.meta.ai` to `/v1` automatically. Do not use a `dev.meta.ai/docs/...` URL, a full `/chat/completions` URL, or dashboard query parameters as the base URL. Custom HTTPS proxies/partners retain their configured path prefix.
2. Set `META_MUSE_CODE_MODEL=muse-spark-1.3`, or another model your key can access that supports structured JSON and image inputs. Replace any explicit `muse-code` variable: a new workflow default does not override an existing variable. Confirm available IDs using `GET https://api.meta.ai/v1/models` with the same server-side key. See Meta's [models](https://dev.meta.ai/docs/models), [authentication](https://dev.meta.ai/docs/authentication), and [structured output](https://dev.meta.ai/docs/structured-output) documentation.
3. Keep `META_API_KEY` in the GitHub secret/Key Vault, not a browser variable. Meta uses `Authorization: Bearer <key>`; no team/project query parameters are needed. Check that the Function's Key Vault reference resolves and that the key belongs to a team with model access. Upstream **401/403** usually indicates credentials or permissions; **400/404** can indicate the wrong path, model ID, or unsupported request format.
4. Update repository and overriding `staging`, `qa`, and `prod` environment variables, then run the normal `main` promotion pipeline with its approval gates. Changing a GitHub variable alone does not update an already deployed Function. For an urgent settings-only correction on the old build, set the deployed Function's `META_API_BASE_URL` to the versioned URL and `META_MUSE_CODE_MODEL` to the supported ID as well; the updated build is required for screenshot scans.
5. After deployment, run a small public web scan without a screenshot, then repeat with a screenshot if needed. Confirm that a real report and scan ID are returned, not just a successful `/api/v1/health` response.

Screenshot interpretation now uses Muse Spark's documented [image understanding](https://dev.meta.ai/docs/image-understanding) request format (`image_url` content in chat completions) and the existing validated report schema. Bounds are estimates in raw screenshot pixels, not segmentation masks or proof of CSS target sizes/contrast compliance. Remove the obsolete `META_SAM_MODEL` setting: Meta documents SAM 3.1 under the separate [media segmentation](https://dev.meta.ai/docs/media-segmentation) Responses API, which cannot satisfy the old chat/JSON screenshot request.

In Application Insights, `AccessiWeb request failed.` includes the web scan stage (`web_scan_identity`, `web_scan_quota`, `fetch_page`, `analyze_page`, or `save_web_scan`). Model failures also include a safe error code and upstream HTTP status when available. Check Cosmos configuration/managed-identity access for quota or persistence failures. These diagnostics do not log raw HTML, source files, model responses, URLs, or bearer tokens. A healthy liveness endpoint alone does not verify a successful scan.
