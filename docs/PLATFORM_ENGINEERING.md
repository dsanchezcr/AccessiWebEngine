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
| `GITHUB_BOT_TOKEN` | Server-side GitHub issue/remediation integration token; stored in Key Vault |
| `META_PREVIEW_INVITE_CODE` | Optional shared preview invite; stored in Key Vault when set |

Set the following Actions variables at repository scope for PR deployments and separately in each `staging`, `qa`, and `prod` environment:

| Variable | Purpose |
| --- | --- |
| `AZURE_DEPLOYMENT_PRINCIPAL_ID` | Service principal object ID used for Key Vault role assignment |
| `META_API_BASE_URL` | OpenAI-compatible Meta Model API base URL |
| `META_ANALYSIS_PROVIDER` | `meta` or `open-weights` |
| `META_MUSE_SPARK_OPEN_URL` | Optional open-weights endpoint |
| `META_MUSE_CODE_MODEL`, `META_SAM_MODEL`, `META_MUSE_WONDER_MODEL`, `META_MUSE_IMAGE_MODEL` | Model identifiers (defaults are supplied by Bicep) |
| `GITHUB_ISSUE_ALLOWED_REPOSITORIES` | Comma-separated `owner/repo` issue-write allowlist |
| `ENTRA_B2C_TENANT_NAME` | B2C tenant short name |
| `ENTRA_B2C_CLIENT_ID` | Client/application ID |
| `ENTRA_B2C_POLICY_NAME` | Sign-up/sign-in policy |
| `ENTRA_B2C_ISSUER` | Exact JWT issuer expected by API verification |
| `VITE_ENTRA_B2C_API_SCOPE` | API scope requested by the frontend |
| `FEATURE_ENABLE_AUTO_PR_PREVIEW` | `true` only for environments where preview remediation is deliberately enabled |

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
    githubBotToken="<GITHUB_BOT_TOKEN>" \
    metaPreviewInviteCode="<OPTIONAL_PREVIEW_CODE_OR_EMPTY>" \
    metaApiBaseUrl="<META_API_BASE_URL>"
```

The Bicep Function App uses a system-assigned identity for Cosmos access in all deployed environments. Local development may instead use `COSMOS_DB_CONNECTION_STRING`; do not add that setting to a deployed Function App. Production sets `APP_ENV=production`, preventing the non-production default preview invite code.

## Workflow behavior

- `.github/workflows/pr-ephemeral.yml` runs typecheck, unit tests, builds, and Bicep compilation. For same-repository PRs it deploys an isolated Azure resource group, publishes the API and frontend, checks `/api/v1/health`, and posts preview URLs. On PR close it requests asynchronous resource-group deletion.
- `.github/workflows/cd-pipeline.yml` validates once, then calls the reusable `.github/workflows/deploy-stage.yml` for `staging`, `qa`, and `prod` in sequence. GitHub environment rules provide the approval gates.
- `.github/workflows/codeql.yml` analyzes JavaScript/TypeScript on pushes, PRs, a weekly schedule, and manual dispatch. `.github/workflows/dependency-review.yml` checks PR dependency changes, while `.github/dependabot.yml` schedules npm and GitHub Actions updates.
- Each environment deployment creates or updates its resources from Bicep before deploying application artifacts. The frontend build receives the deployed Function URL and copies `staticwebapp.config.json` into the SWA artifact.

The current automated checks are TypeScript typechecks, Node tests, production builds, Bicep compilation, and an API health check. This repository does not yet include a browser-based Playwright/axe suite or a dedicated ESLint script; the workflows intentionally do not claim those checks ran.

The promotion workflow is restricted to `main` for both pushes and manual dispatch. Set each GitHub environment's deployment-branch rule to `main` as an additional protection, and require production reviewers.

## Operational notes

- The API health endpoint is a liveness response; it does not prove that Cosmos DB, Meta, or GitHub are reachable.
- PR resource deletion uses `--no-wait`. Verify the resource group is deleted after workflow completion if Azure deletion is delayed.
- Resource names are deterministic within each resource group and globally unique where Azure requires it.
- The templates use public service endpoints with HTTPS, CORS restrictions, managed identity, RBAC, and app-level controls. They do not provision private endpoints, a VNet, a WAF, or a customer-managed encryption key.
- Validate the current Azure region/SKU availability and quota before a production rollout.
