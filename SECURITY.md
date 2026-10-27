# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub Security Advisories** ("Report a vulnerability" on the repository's Security tab). Do not open public issues for security problems.

Security contact: *to be configured by the maintainer*.

Please include affected versions or commits, reproduction steps and impact. We aim to acknowledge reports promptly and to coordinate disclosure once a fix is available.

## Scope

In scope:
- the API, OAuth server and MCP server,
- tenant isolation,
- authentication,
- provider-credential handling,
- the Cloudflare and Docker deployment configurations in this repository.

Out of scope:
- third-party data providers themselves,
- deployments that changed the default security settings.

Design details: [docs/SECURITY.md](docs/SECURITY.md).
