# Project cover

The capture executes the real DSC cache query against committed fake-cache fixtures and renders its JSON output. It does not contact Salesforce APIs or read the user cache.

Install Node.js and the project development dependencies first. The capture also requires `jq`. Browser capture dependencies are isolated under `tools/cover`; the preparation command installs their lockfile and pinned Chromium automatically.

After committing source changes, prepare the canonical image and its source record:

```bash
scripts/prepare-cover
```

Commit `docs/screenshots/cover.png` and `docs/screenshots/cover-source.json` together. The source record hashes the committed tree except those generated files, then hashes the PNG separately, so changing the record does not invalidate itself. Publication preparation performs this capture and commit before generating distribution tips. The freshness check refuses publication when committed inputs or image bytes no longer match the record.

```bash
scripts/prepare-cover --check
scripts/prepare-cover --output /tmp/project-cover.png
scripts/release-check
```

`--output` creates a review artifact without changing the canonical image or its record. The release check validates the committed record and captures a fresh review artifact; `COVER_OUTPUT` chooses where that artifact is retained. Source validation runs the same check and retains the rendered PNG. A generated distribution tip changes repository references, so run freshness checks against neutral source history.
