# Threat model
Owner: security-reviewer. Updated whenever a new endpoint, data flow, integration, or role appears.

## Assets
<User accounts, personal data, payment info, API keys, ...>

## Trust boundaries
Browser ↔ Backend · Backend ↔ Database · Backend ↔ External services · CI ↔ Repository/secrets

## Threats (STRIDE)
| ID | Boundary | Threat | Category | Mitigation | Status |
|---|---|---|---|---|---|
| T1 | Browser ↔ Backend | Session theft via XSS | Spoofing | httpOnly cookies, CSP, output encoding | planned |

## Open risks
<Accepted risks with the owner's sign-off and date.>
