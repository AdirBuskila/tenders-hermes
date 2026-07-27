# Execution sandbox for the Hermes tenders agent.
#
# Base is pinned to the exact Playwright version in tenders-search-automation
# (playwright 1.60.0). If that dependency is bumped, bump this tag in the same
# commit — a mismatch between the driver and the bundled browsers fails at
# runtime with an unhelpful error.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# The Playwright image ships Node 22 and the browsers, but none of the shell
# utilities Hermes' terminal toolset reaches for. ripgrep in particular is what
# the agent uses to search the read-only production repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ripgrep \
        jq \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    # Node 22 resolves bare imports from the importing file's location, so
    # harness scripts in /workspace can import production modules from /repo
    # and those modules still resolve their own deps out of /repo/node_modules.
    NODE_OPTIONS=--no-warnings

WORKDIR /workspace

# Sanity check at build time rather than at 03:00 during a cron run.
RUN node --version && python3 --version && rg --version | head -1
