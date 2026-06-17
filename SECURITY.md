# Security

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security Advisories) on this repository, or by opening a minimal issue that does
**not** include any secrets, tokens, or personal footage. We'll respond as soon as
we reasonably can. This is a volunteer, best-effort project (see the no-warranty
note in [LICENSE](./LICENSE)).

## Handling of credentials

- This tool never stores your Ring password. The interactive login exchanges it for
  a **refresh token**, written to `.ring-token.json` with `0600` permissions.
- That token grants full access to your Ring account; treat it like a password.
- `.ring-token.json`, `.env`, and `config.local.json` are git-ignored. **Never commit
  them.** Run `git status` before your first commit to confirm.
- Rotated tokens are persisted automatically; the token value is never written to logs.
- `RING_DEBUG=1` enables verbose `ring-client-api` logging, which may include sensitive
  request details. Use it only for local troubleshooting, never in shared logs.

## Known dependency advisory (`npm audit`)

`npm audit` reports high-severity findings that all trace to a single transitive
dependency: the `ip` package's `isPublic` SSRF miscategorization
([GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp)), pulled in
via `werift` / `werift-ice` (the WebRTC NAT-traversal stack) beneath `ring-client-api`.

- **Not in this project's code.** Nothing here calls `ip` directly; it lives in the
  WebRTC ICE candidate layer.
- **Do NOT run `npm audit fix --force`.** Its only "fix" downgrades `ring-client-api`
  to `9.13.0` (pre-WebRTC), which breaks streaming entirely. This project intentionally
  pins `ring-client-api@14.3.0`.
- **Cannot be resolved downstream.** The current latest `ring-client-api` still depends
  on the affected versions; it will clear once `werift` updates upstream.
- **Low practical risk for this use case.** The `ip` SSRF is relevant when an attacker
  controls connection targets and the app relies on `ip.isPublic()` for SSRF protection.
  Here, the WebRTC session connects to *your own* Ring account over authenticated,
  DTLS-encrypted media; there is no untrusted-peer attack surface in a personal recorder.

We track this and will bump `ring-client-api` when an upstream release clears the advisory.
