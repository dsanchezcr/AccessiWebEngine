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

## Bonus-prize fit

- **Open weights:** repository analysis can be routed to a configured open-weights endpoint.
- **Creative/multimodal:** screenshot analysis and optional audio/image model integrations can be enabled when supported endpoints and credentials are available.
- **Agentic use case:** remediation planning, patch validation, documentation, and PR publication form a multi-step workflow; emphasize that the PR remains subject to human review.
- **Virality:** audit summaries, share actions, and a score badge in embeddable Markdown are available in the product.

The prize alignment is a positioning draft, not a claim that every bonus requirement has been independently validated.

## Three-minute demo script

1. **0:00–0:25 — Problem and product.** Introduce accessibility debt and the three paths: web audit, repository audit, and gated remediation preview.
2. **0:25–1:05 — Live web audit.** Enter a public HTTPS page, run the analysis, and point out the score, findings, and optional screenshot context. Explain that this is automated guidance, not a certification.
3. **1:05–1:45 — Source-code audit.** Scan a public GitHub repository and show file/line-oriented findings. Explain the issue report option and repository allowlist.
4. **1:45–2:30 — Proposed remediation.** If the preview is enabled, sign in, enroll with the server-side invite or approved account, run remediation, and open the resulting PR. Highlight the diff and report, and state that a human must review it.
5. **2:30–3:00 — Responsible implementation.** Show the TypeScript/Azure architecture, managed identity and Key Vault configuration, and explain SSRF/rate-limit controls and remaining production validation.

## Before submission

Replace this draft with the exact deployed demo URL, screenshots/video, tested model names, and confirmed outputs. Do not state a score, accessibility conformance, model partnership, or infrastructure deployment as completed unless it has been checked against the live build.
