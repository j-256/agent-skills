# Documentation

Repository-wide guidance lives under `docs/`. Package-specific documentation and worked examples live with the self-contained plugin that owns them.

## Start here

- [Distribution and installation](distribution.md) covers plugin contents, supported clients, repository sources, authentication, and maintainer validation.
- [Worked examples](examples/) catalogs captured outputs from the shipped skills.
- [Contributing](../CONTRIBUTING.md) covers change preparation, validation, and pull requests.

## Plugin documentation

- [DSC architecture and design rationale](../plugins/dsc/docs/dsc-skills.md) explains the shared scraping layer, skill boundaries, coverage, and extension points.
- [Commerce authentication model](../plugins/dsc/docs/commerce-auth-matrix.md) records the runtime-verified SCAPI, OCAPI, and SLAS authentication behavior used by the DSC skills.
- [DSC plugin](../plugins/dsc/), [Fork and PR plugin](../plugins/fork-and-pr/), and [Stepped Demo Script plugin](../plugins/stepped-demo-script/) document package-specific installation and validation.
