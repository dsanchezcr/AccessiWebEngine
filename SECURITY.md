# Security

## Security boundaries

The browser is an untrusted client. Meta and GitHub credentials, Cosmos access, scraping, token verification, and GitHub writes remain in the Functions API. `VITE_*` settings are public build-time configuration and must never contain credentials.

## Controls in this repository

- **Authentication and authorization:** Protected user endpoints verify Entra ID B2C bearer tokens against the configured audience, exact issuer, tenant policy signing keys, and require a subject. Autonomous remediation additionally requires the global feature switch and the user's persisted preview flag.
- **Preview enrollment:** `POST /api/v1/users/me/preview-access` requires a valid user token and either a server-side invite code or a Cosmos user record with `previewAccessApproved: true`. `META-HACKATHON-2026` is only a non-production/demo default; production has no default code. Treat any configured invite as a shared secret and rotate it after a demo.
- **SSRF:** Web targets are parsed, resolved, checked against private/special IP ranges, and each redirect is revalidated. Requests pin DNS resolution to the validated public address, bound redirects and response size, and do not execute fetched page scripts.
- **GitHub write scope:** Automated issue creation is disabled without an explicit repository allowlist. Remediation commits are restricted to a verified public fork owned by the bot; the API never uses the bot's upstream push permission and rejects targets owned by the bot itself. GitHub tokens should be restricted to the minimum repositories and permissions needed. Remediation output is proposed in a PR rather than merged.
- **Rate limits:** Scans and generated audio/images share the anonymous/authenticated scan quota; remediation uses a separate per-user quota. Quotas are recorded in Cosmos DB. The Functions API hashes the selected forwarded address for anonymous quota keys; forwarded-address behavior depends on the hosting proxy configuration and should be verified before relying on IP quotas as a strong identity boundary.
- **Secret storage:** Deployment places Meta, dedicated open-weights partner, and GitHub tokens in an RBAC-enabled Key Vault and injects Key Vault references into Function App settings. The open-weights route does not forward the Meta API key to the partner. Managed identity grants the application access to secrets and Cosmos DB. `AZURE_CREDENTIALS` remains a high-impact deployment credential and should be protected and rotated.
- **Browser response controls:** SWA configuration sets CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a restrictive Permissions Policy.
- **Supply-chain checks:** `.github/workflows/codeql.yml` runs CodeQL on main pushes, PRs, weekly, and by manual dispatch. `.github/workflows/dependency-review.yml` blocks PR dependency changes with moderate-or-higher known advisories. Dependabot proposes weekly npm and GitHub Actions updates; review and test each update before merging.
- **Infrastructure identity:** Bicep assigns Key Vault Secrets User and Cosmos DB Built-in Data Contributor roles to the Function App system-assigned identity. No Cosmos key is injected into the deployed app.

## Deployment and operations

The PR workflow only deploys trusted same-repository PRs; fork PRs receive validation but no Azure secrets. Protect `main`, review workflow changes, restrict repository/environment secret access, and require reviewers for production. The workflow service principal is subscription-scoped because deployments create resource groups and role assignments; prefer a dedicated identity and reduce its scope/permissions where the deployment model permits.

The infrastructure currently uses public Azure endpoints, has no private networking/WAF, and has no separate secrets-rotation automation. Operators should monitor Application Insights and Azure Activity Logs, rotate tokens immediately after suspected exposure, and review access to Key Vault and GitHub environments.

## Known limitations and reporting

- Rate limiting and auth controls do not replace edge-level abuse protection or a production API gateway.
- Dependency review covers changes introduced by a PR; it is not a continuous full dependency vulnerability scan. The Azure Identity/MSAL UUID dependency is pinned by an override; continue auditing the resolved lockfile for new advisories.
- Cosmos rate-limit checks are read-then-write, not an atomic distributed counter; concurrent requests can exceed a limit briefly.
- Anonymous scans are persisted without a user owner, so the authenticated data-deletion route cannot associate them with a person.
- Security headers and accessibility are not equivalent to a complete security or WCAG audit. Review deployed headers, authentication policy, Azure RBAC, and generated patches before production use.

Report suspected vulnerabilities privately to the repository maintainers. Do not include live tokens, personal data, or sensitive repository contents in an issue.
