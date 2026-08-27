# Security

tollbooth handles payment authorizations and signing keys, so we want to
hear about vulnerabilities quickly and quietly.

**Report privately** via GitHub's private vulnerability reporting on this
repository (Security → Report a vulnerability). Please do not open a public
issue for anything exploitable.

- Supported: the latest 1.x release.
- We aim to acknowledge within 72 hours and to fix or publish a mitigation
  before any public disclosure.
- No bounty program at this time; credit given gladly.

Out of scope by design (documented in the README's honest-limits section
and the constitution): soft-enforcement over-spend within `replay_window`,
stealth full-browser agents passing as humans, and per-instance state
resetting on restart. Reports that reduce to those are welcome as
discussions, not advisories.
