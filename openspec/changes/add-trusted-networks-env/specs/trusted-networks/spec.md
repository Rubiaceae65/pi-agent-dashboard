## ADDED Requirements

### Requirement: Deployment-declared trusted sources from PI_DASHBOARD_TRUSTED_NETWORKS
The server SHALL read `PI_DASHBOARD_TRUSTED_NETWORKS` (comma- and/or whitespace-separated)
and merge each VALID entry into `resolvedTrustedNetworks`, whether or not `config.json`
exists. A valid entry is an exact IPv4 or IPv6 address, or an IPv4 CIDR with a prefix
length from 8 to 32. Any other entry — a wildcard, a hostname, an IPv4 prefix shorter than
`/8` (including `0.0.0.0/0`), an invalid prefix, or an IPv6 CIDR (including `::/0`) — SHALL
be dropped with a warning naming the entry, and SHALL NOT stop the server. Env entries
SHALL NOT be written to `config.json` nor appear in `trustedNetworks`.

#### Scenario: Declared gateway peer passes the universal guard
- **WHEN** `PI_DASHBOARD_TRUSTED_NETWORKS=10.244.0.243/32` and a request to `/mobile/` or `/api/sessions` has socket peer `10.244.0.243`
- **THEN** the universal network guard admits it

#### Scenario: Other peers stay refused
- **WHEN** the socket peer is `10.244.0.50`, with or without `X-Forwarded-For: 10.244.0.243`
- **THEN** the guard responds 403 `network_not_allowed`

#### Scenario: Blanket entries are refused
- **WHEN** the variable lists `0.0.0.0/0`, `*`, `::/0` or a hostname
- **THEN** those entries are dropped with a warning and grant no trust

### Requirement: Env-declared sources do not widen CORS origin decisions
Entries listed in `PI_DASHBOARD_TRUSTED_NETWORKS` SHALL NOT make an `Origin` a
trusted-network origin in the CORS / origin-admission decision. Other `trustedNetworks` /
`auth.bypassHosts` entries keep their existing CORS allowance.

#### Scenario: Origin naming the gateway address is not trusted
- **WHEN** `PI_DASHBOARD_TRUSTED_NETWORKS=10.244.0.243/32` and a request carries `Origin: http://10.244.0.243:8000`
- **THEN** the origin is not classified as a trusted-network origin
