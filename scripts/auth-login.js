#!/usr/bin/env node
/**
 * One-time Microsoft sign-in for an account with `auth: microsoft`.
 *
 * This is the only step in the whole project that needs a person: Microsoft requires an
 * interactive device-code sign-in the first time. It runs OUTSIDE the bot process (the bot
 * itself never prompts and stops with reason `auth_required` instead). The refresh token is
 * cached under auth.profilesFolder and renewed automatically afterwards.
 *
 *   npm run auth -- --config config.yaml --id main
 */
import prismarineAuth from 'prismarine-auth'
import { loadConfig } from '../src/config.js'

const { Authflow, Titles } = prismarineAuth

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const configPath = arg('config') ?? process.env.HMC_CONFIG ?? './config.yaml'
const id = arg('id')
if (!id) { process.stderr.write('usage: npm run auth -- --config config.yaml --id <account id>\n'); process.exit(2) }

let config
try { config = loadConfig(configPath) } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2) }
const account = config.accounts.find(a => a.id === id)
if (!account) { process.stderr.write(`no account with id "${id}" in ${configPath}\n`); process.exit(2) }
if (account.auth !== 'microsoft') { process.stderr.write(`account "${id}" uses auth "${account.auth}", nothing to sign in\n`); process.exit(2) }

// Same options minecraft-protocol uses for auth: 'microsoft', so the bot finds this cache.
const flow = new Authflow(account.username, config.auth.profilesFolder, {
  authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live'
}, resp => process.stdout.write(`\n${resp.message}\n\nWaiting for you to finish signing in...\n`))

const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: !config.client.disableChatSigning })
if (!profile || profile.error) {
  process.stderr.write(`signed in, but no Minecraft Java profile was returned (does the account own the game?)\n`)
  process.exit(1)
}
process.stdout.write(`\nsigned in as ${profile.name}; tokens cached in ${config.auth.profilesFolder}\n`)
process.exit(0)
