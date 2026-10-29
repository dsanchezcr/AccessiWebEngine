# Privacy and data handling

AccessiWeb Engine processes web URLs and public repository source to generate accessibility findings. It is intended for developer use; do not submit credentials, private source, or personal/sensitive data in scan targets or prompts.

## Data processed

| Data | Use and storage |
| --- | --- |
| Submitted target URL or public repository URL | Used to fetch/analyze a scan and stored with the resulting report in Cosmos DB |
| Findings, scores, audit metadata, and optional visual analysis | Stored as the scan report; user-provided screenshots are analyzed in memory and are not persisted by this application |
| Entra subject and optional profile fields | Stored in the `users` container for account and feature-flag behavior |
| Remediation repository, branch, commit, and PR URL | Stored in the `remediations` container for the authenticated user |
| Rate-limit event timestamps and hashed anonymous client key | Stored in `rateLimits` to enforce request quotas; container items expire after the configured 3,600-second TTL |
| Submitted HTML/source code | Passed to the analysis service in memory; raw HTML and source-file contents are not written as separate records by this application |

The external Meta API and GitHub receive the data necessary to perform requested analysis or create a GitHub issue/PR. Their processing and retention are governed by those services' terms and settings.

## Retention and deletion

The `rateLimits` container uses TTL. The application does not currently set an automatic TTL for scans, user profiles, or remediation records; those records remain until a user deletes their account data or an operator removes the deployment/database. Cosmos backup and diagnostic retention are controlled by Azure configuration and account policies.

Authenticated users can request deletion through `DELETE /api/v1/users/me/data`. It deletes their profile, attributed scans, and remediation records. A scan created anonymously has no user association and therefore cannot be found through that user deletion flow. Do not treat this endpoint as a complete deletion mechanism for anonymous scans, Azure backups, or copies held by Meta/GitHub.

For deployments handling personal data, define and document a retention period, configure Azure backup/diagnostic policies to match it, add an operator process for anonymous-record deletion, and validate deletion behavior end to end before launch.

## Data minimization and user choices

- Avoid including personal data in target pages, repository fixtures, issue bodies, and remediation prompts.
- Use only public URLs and public repositories for the public experiences.
- Screenshots are optional and are not retained by this application.
- Review generated GitHub issues and remediation pull requests before publishing or merging.
- Configure GitHub bot access and Meta API settings only for the repositories and environments that need them.

This document describes current application behavior, not a legal determination or a guarantee about third-party service retention.
