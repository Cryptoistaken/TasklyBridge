package main

// notWhitelisted is the reply for anyone who is not the bound end user.
//
// Two things are true at once and both have to be said. The service relays a
// third party's Telegram bot, because a user pasting a number into an unknown
// bot deserves to know who is on the other end of it. And access is by
// whitelist, because every user needs a dedicated Telegram account and that
// account is the scarce, ban-prone resource: the provider keeps per-chat state
// so it cannot be shared, which is what makes this slow and cautious rather
// than merely unfinished.
//
// Keeping this text in one place also means there is exactly one thing to
// review when the wording changes, rather than a string buried in a handler.
const notWhitelisted = `Hi! This service is not open to everyone yet.

How it works: this bot is a bridge. Anything you send goes to TasklyBux on your
behalf, and their reply comes back to you here. It is not TasklyBux itself, and
they do not know your messages pass through this bot.

Right now access is by whitelist. Each user needs their own Telegram account on
our side, and those are limited and must be set up carefully, so we add people
one at a time.

If you would like to be added, message the admin.`

// notWhitelistedShort is the one-line version, for a callback tap where a
// paragraph would be noise.
const notWhitelistedShort = `Access is by whitelist right now. Each user needs a
dedicated Telegram account on our side, and those are limited, so we add people
one at a time. Message the admin to be added.`
