# Playwright's own image, pinned to the version installed in node_modules.
#
# This is NOT a convenience choice. The obvious Dockerfile (install playwright,
# run `playwright install chromium`) fails here: the CDN redirects to a raw IP
# and something on the network intercepts TLS, so every download dies with
# ERR_TLS_CERT_ALTNAME_INVALID against https://150.171.109.132/... . The official
# image ships chromium-1243 already in /ms-playwright, which is precisely the
# build the download was trying to fetch, so nothing has to be fetched at all.
#
# The tag MUST match the installed playwright version. node_modules is 1.63.0.
# A mismatch fails at launch with an error that reads like nothing to do with
# versions.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# bun, copied rather than installed, so the build needs no network for it either.
# Must be 1.4: bun.lock is written by the local bun 1.4.0, and 1.2 cannot parse it
# ("Unknown lockfile version"), which fails --frozen-lockfile.
COPY --from=oven/bun:1.4-debian /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Dependencies first, so a code change does not reinstall the world.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.js db.js bot.js ./

# data/ is NOT copied. It holds .env, the Telegram sessions and the account
# sheets, and .dockerignore excludes all of it - the only thing code ever read
# from there was a comment. It is mounted at run time instead.
RUN mkdir -p /app/data/out /app/data/sessions

# A container has no display, so the browser is headless with Playwright's bundled
# Chromium. See launchBrowser in index.js - headless is less stealthy than the
# headed desktop path, which is why this is env-driven and not hardcoded.
ENV FB_HEADLESS=1
ENV NODE_ENV=production

# Two long-running processes, run as two services from this one image:
#   bot      bun bot.js
#   drain    bun index.js --drain --watch
CMD ["bun", "bot.js"]
