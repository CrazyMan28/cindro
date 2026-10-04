# Self-hosted workflow copies (inactive)

GitHub only runs workflows in `.github/workflows/`. The files here are the
**self-hosted** versions of the build and PR-check workflows, saved exactly as
they were when CI moved to GitHub-hosted runners (2026-10-04). Nothing here runs.

To switch back to the self-hosted fleet (`win-runner-*`, `pve-ubuntu-runner-*`),
copy them back over the active ones:

```bash
cp .github/workflows-selfhosted/*.yml .github/workflows/
```

The runner provisioning is unchanged and still in place:
- `windows/scripts/setup-runner-*.ps1`
- `infra/ci-image/` (the `jarvis-ci` container image)
- `.github/workflows/runner-maintenance.yml` (manual, still self-hosted)
