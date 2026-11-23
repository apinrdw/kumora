# Teardown reads Infisical by GitHub OIDC as a Viewer

The preview teardown workflow needs Infisical secrets to run alchemy. Alchemy logs into Infisical with GitHub's OIDC token as the `kumora-github-teardown` identity, so GitHub stores no secret. The identity is a project Viewer, so it can read `prod` too: Infisical's free plan has no per-environment roles. This is accepted like the Workers Builds identity's access; revisit with custom roles or outside contributors.

Sites:
- `.github/workflows/teardown-preview.yml`

Source: apinrdw/kumora#18
