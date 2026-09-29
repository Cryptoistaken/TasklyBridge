# Playwright's own image. It already carries Chromium plus every system library
# Chrome needs, which is otherwise a long fight with missing .so files. The tag
# MUST match the installed playwright version exactly - node_modules here is
# 1.63.0, and a mismatched image fails at launch with a version error that looks
# like nothing to do with versions.
FROM oven/bun:1.2-debian

ARG PLAYWRIGHT_VERSION=1.63.0

# Chromium + the Linux dependencies. --with-deps pulls the apt packages.
RUN bun add -g playwright@${PLAYWRIGHT_VERSION} \
 && playwright install --with-deps chromium

WORKDIR /app

# Dependencies first so a code change does not reinstall the world.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.js db.js bot.js ./
COPY data/doc ./data/doc

# data/ holds secrets, the Telegram sessions and the account sheets. None of it
# is in the image - it is mounted or injected as env at run time. The folder has
# to exist for the mounts to land on.
RUN mkdir -p /app/data/out /app/data/sessions

# Container has no display, so the browser is headless with Playwright's bundled
# Chromium. See launchBrowser in index.js for why that is a risk, not a detail.
ENV FB_HEADLESS=1
ENV NODE_ENV=production
ENV TOOL_DEBUG=

# Two long-running processes, run as two services from this one image:
#   bot      bun bot.js
#   drain    bun index.js --drain --watch
# The default is the bot, which is the safe one to smoke-test first.
CMD ["bun", "bot.js"]
