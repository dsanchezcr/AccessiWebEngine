# Meta Global AI Developer Hackathon submission draft

## Project summary

**AccessiWeb Engine** helps developers turn accessibility findings into actionable work. It accepts a public web URL or repository, generates structured WCAG-oriented audit findings, and can prepare GitHub issues. A separately gated remediation preview can analyze a repository, generate candidate patches, and open a reviewable pull request with a remediation report.

## Rubric alignment

### Impact — 30%

Accessibility checks are integrated into workflows developers already use: a URL scan, source audit, issue draft, or proposed remediation PR. Findings include actionable context, and patches are reviewable rather than merged automatically. The application itself is built with accessible UI practices, but this submission does not claim zero Axe violations or WCAG 2.2 AAA conformance without a complete automated and manual audit.

### Use of Meta AI tooling — 25%

The engine is configured for a Meta-compatible chat-completions endpoint and model names through server-side settings. It supports structured audit output, optional screenshot analysis, and configured open-weights routing. Optional audio and accessible-image generation are exposed when corresponding model endpoints are configured. The actual models and endpoint capabilities must be confirmed in the event environment; this draft does not claim access to unreleased or unavailable model endpoints.

### Technical depth — 20%

The implementation uses TypeScript npm workspaces, Azure Functions, Cosmos DB, Entra ID B2C JWT verification, managed identity, Key Vault references, rate-limit storage, URL/DNS SSRF controls, and modular Bicep. GitHub Actions define PR-scoped environments and staged promotion. Production deployment still requires organization credentials, B2C configuration, Azure quota/region review, and operator validation.

### Demo — 25%

The demo shows a real public URL audit and repository audit, reviews the generated findings, and demonstrates the GitHub issue flow. If the private preview prerequisites are configured, it also shows authenticated preview enrollment and a generated remediation PR. Keep the report and PR review visible so the audience can distinguish AI suggestions from verified conformance.
