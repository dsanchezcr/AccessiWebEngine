# AccessiWeb Engine Copilot Instructions

## Project structure

- This is a TypeScript npm-workspaces monorepo: `apps/web` is the React/Vite frontend, `apps/api` is the Azure Functions API, and `packages/engine` and `packages/shared` contain reusable analysis and contract code.
- The API uses NodeNext resolution. Keep `.js` extensions on runtime-relative imports in API and engine TypeScript; use `.ts` extensions only where the compiler rewrites relative import extensions.
- Keep changes focused and preserve the existing split between frontend, API, shared contracts, and engine.

## Accessibility

- Treat accessibility as a product requirement. Use semantic HTML, accessible names, keyboard support, visible focus, adequate contrast, reduced-motion support, and responsive layouts.
- Run `npm run test:e2e` for frontend changes. The Playwright suite uses axe-core across public routes and color themes and saves screenshots under ignored `test-results/playwright/`.
- Automated axe results do not prove WCAG conformance. Do not claim complete WCAG 2.2 AAA compliance without appropriate manual testing.

## Security and privacy

- Treat URLs, page markup, repository files, model responses, and user-uploaded data as untrusted.
- Preserve URL validation, DNS pinning, redirect validation, size limits, authentication, rate limiting, and repository write allowlists when changing related flows.
- Keep credentials server-side. Do not log or persist raw page HTML, repository source, screenshots, or bearer tokens.
- Validate external request bodies and model outputs with the existing shared Zod schemas where applicable.

## Validation

- Use the existing scripts: `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`.
- For infrastructure or workflow changes, validate Bicep with `az bicep build --file infra/bicep/main.bicep --stdout` and validate workflow YAML.
- Update relevant documentation and CI workflows when behavior or validation requirements change.
