package main

// notWhitelisted is the reply for anyone who is not the bound end user.
//
// Kept to one sentence on purpose. The full explanation of why access is by
// whitelist — each user needs a dedicated Telegram account on our side, and
// those are limited and must be set up carefully — is real and worth telling
// people, but a wall of text to someone who just wanted to use the bot is the
// wrong place for it. The operator can add the detail here if they want it.
//
// Kept in one place so there is exactly one thing to review when the wording
// changes, rather than a string buried in a handler.
const notWhitelisted = `You are not whitelisted.

This service is in testing and each user needs their own Telegram account on our
side, so we add people one at a time. Message the admin to be added.`
