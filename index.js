const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const rules = require('./rules');
const strikesTracker = require('./strikes');
const passesTracker = require('./passes');
const ai = require('./ai');
const log = require('./logger');

// ── Boot sequence ──────────────────────────────────────────────
log.banner();
log.info('CORE', 'Bootstrapping moderation engine...');
log.info('CONFIG', `Loaded ${rules.length} active rule(s): ${log.C.bold}${rules.map(r => r.name).join(', ')}${log.C.reset}`);
log.info('CONFIG', `Strike threshold: ${config.MAX_STRIKES}  |  Max msg length: ${config.MAX_MESSAGE_LENGTH} chars`);
log.info('CONFIG', `AI roast engine: ${process.env.GROQ_API_KEY ? log.C.green + 'ENABLED (Groq)' + log.C.reset : log.C.yellow + 'DISABLED (fallback templates)' + log.C.reset}`);
log.info('CONFIG', `Target group: ${config.GROUP_ID ? log.C.dim + config.GROUP_ID + log.C.reset : log.C.yellow + 'UNCONFIGURED (discovery mode)' + log.C.reset}`);

// Initialize client with LocalAuth for session persistence
const client = new Client({
    authStrategy: new LocalAuth()
});

// ── Lifecycle events ───────────────────────────────────────────
client.on('qr', (qr) => {
    log.warn('AUTH', 'No active session found. Awaiting device link...');
    log.info('AUTH', 'Scan the QR code below (WhatsApp → Linked Devices → Link a Device):');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    log.ok('AUTH', 'Credentials authenticated. Session persisted via LocalAuth.');
});

client.on('auth_failure', (msg) => {
    log.error('AUTH', `Authentication failed: ${msg}`);
});

client.on('loading_screen', (percent) => {
    log.info('SYNC', `Hydrating session state... ${percent}%`);
});

client.on('disconnected', (reason) => {
    log.error('CONN', `Connection lost (${reason}). Attempting to recover...`);
});

let botId = null;       // the bot's @c.us id
// All numeric forms that identify the bot (c.us number + any configured @lid).
// Mentions arrive as @lid, so we must know the bot's @lid to match them.
const botNums = new Set(config.BOT_IDS);

client.on('ready', async () => {
    botId = client.info?.wid?._serialized || null;
    if (botId) botNums.add(botId.split('@')[0]);

    // Try to discover the bot's @lid automatically.
    try {
        const me = await client.getContactById(botId);
        const lid = me?.lid?._serialized || me?.id?._serialized;
        if (lid) botNums.add(String(lid).split('@')[0]);
    } catch (_) { /* ignore */ }

    log.ok('CORE', `${log.C.bold}Engine online — monitoring active.${log.C.reset}`);
    log.info('CORE', `Bot identity: ${botId || 'unknown'}  |  known IDs: ${[...botNums].join(', ') || 'none'}`);
    log.info('CORE', 'Listening for inbound message events...');
});

// Resolve a target person to a WhatsApp ID, preferring an explicit @mention in
// the command, otherwise fuzzy-matching the name against group participants.
async function resolveTarget(chat, message, name) {
    // 1) Prefer any non-bot @mention the admin included.
    const mentioned = (message.mentionedIds || []).filter(id => !botNums.has(String(id).split('@')[0]));
    if (mentioned.length > 0) return mentioned[0];

    // 2) Fuzzy match by contact name against participants.
    if (!name) return null;
    const needle = name.toLowerCase().trim();
    for (const p of chat.participants) {
        try {
            const c = await client.getContactById(p.id._serialized);
            const cname = (c.pushname || c.name || c.number || '').toLowerCase();
            if (cname && (cname.includes(needle) || needle.includes(cname))) {
                return p.id._serialized;
            }
        } catch (_) { /* skip */ }
    }
    return null;
}

// Pending kick confirmations: requesterId -> { targetId, expiry }
const pendingKicks = {};

// Destructive actions only the boss may run.
const BOSS_ONLY = new Set(['kick', 'warn', 'forgive', 'mute']);

// Execute a parsed command. Returns true if it performed an action.
// `role` is the requester's role ('boss' | 'coadmin').
async function executeCommand(cmd, chat, message, role) {
    if (!cmd || !cmd.action) return false;

    const tag = (id) => '@' + String(id).split('@')[0];

    // Gate destructive actions to the boss only.
    if (BOSS_ONLY.has(cmd.action) && role !== 'boss') {
        await chat.sendMessage('⚠️ Only the big boss can issue that command. 👑');
        log.warn('COMMAND', `${cmd.action} blocked — requester role=${role} (boss-only).`);
        return true;
    }

    switch (cmd.action) {
        case 'kick': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}" to remove.`);
                log.warn('COMMAND', `kick: target "${cmd.target}" not found.`);
                return true;
            }
            // Never allow kicking an admin/boss/coadmin.
            const tNum = String(target).split('@')[0];
            if (config.roleOf([tNum]) !== 'member') {
                await chat.sendMessage(`⚠️ Boss, ${tag(target)} is an admin — I won't remove them.`);
                log.warn('COMMAND', `kick refused — ${tNum} is an admin.`);
                return true;
            }
            // Require confirmation before the destructive action.
            const requester = message.author;
            pendingKicks[requester] = { targetId: target, expiry: Date.now() + 60000 };
            await chat.sendMessage(
                `⚠️ Confirm: remove ${tag(target)} from the group? Reply "yes" within 60 seconds to confirm.`,
                { mentions: [target] }
            );
            log.event('COMMAND', `kick pending confirmation → ${cmd.target}`);
            return true;
        }
        case 'warn': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}" to warn.`);
                return true;
            }
            const strikes = strikesTracker.addStrike(target);
            const reason = cmd.reason || 'admin warning';
            await chat.sendMessage(
                `${tag(target)} ⚠️ Warning from the boss: ${reason}. Strike ${strikes}/${config.MAX_STRIKES}.`,
                { mentions: [target] }
            );
            log.ok('COMMAND', `warn → ${cmd.target} (strike ${strikes}/${config.MAX_STRIKES}).`);
            return true;
        }
        case 'forgive': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}" to forgive.`);
                return true;
            }
            strikesTracker.resetStrikes(target);
            await chat.sendMessage(`${tag(target)} ✅ The boss has cleared your strikes. Behave. 😇`, { mentions: [target] });
            log.ok('COMMAND', `forgive → ${cmd.target} (strikes reset).`);
            return true;
        }
        case 'mute': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}".`);
                return true;
            }
            passesTracker.consumePass(target); // revoke any active pass
            await chat.sendMessage(`${tag(target)} 🔒 Your rule-free pass has been revoked.`, { mentions: [target] });
            log.ok('COMMAND', `mute → ${cmd.target} (pass revoked).`);
            return true;
        }
        case 'mention': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}" in the group.`);
                log.warn('COMMAND', `mention: target "${cmd.target}" not found.`);
                return true;
            }
            const text = `${tag(target)} ${cmd.text || ''}`.trim();
            await chat.sendMessage(text, { mentions: [target] });
            log.ok('COMMAND', `mention → ${cmd.target} executed.`);
            return true;
        }
        case 'roast': {
            const target = await resolveTarget(chat, message, cmd.target);
            if (!target) {
                await chat.sendMessage(`⚠️ Boss, I couldn't find "${cmd.target}" to roast.`);
                log.warn('COMMAND', `roast: target "${cmd.target}" not found.`);
                return true;
            }
            const roast = await ai.roastPerson(cmd.target) || 'consider yourself roasted.';
            await chat.sendMessage(`${tag(target)} ${roast}`, { mentions: [target] });
            log.ok('COMMAND', `roast → ${cmd.target} executed.`);
            return true;
        }
        case 'announce': {
            const ids = chat.participants.map(p => p.id._serialized);
            const opts = cmd.tagAll ? { mentions: ids } : {};
            const prefix = cmd.tagAll ? ids.map(tag).join(' ') + '\n' : '';
            await chat.sendMessage(`📢 ${prefix}${cmd.text || ''}`.trim(), opts);
            log.ok('COMMAND', `announce executed (tagAll=${!!cmd.tagAll}).`);
            return true;
        }
        case 'tagall': {
            const ids = chat.participants.map(p => p.id._serialized);
            const text = `${ids.map(tag).join(' ')}${cmd.text ? '\n' + cmd.text : ''}`;
            await chat.sendMessage(text, { mentions: ids });
            log.ok('COMMAND', `tagall executed (${ids.length} members).`);
            return true;
        }
        default:
            return false; // 'chat' or unknown → caller handles as conversation
    }
}

// ── Message pipeline ───────────────────────────────────────────
client.on('message', async (message) => {
    // Discovery mode: surface IDs so the operator can configure GROUP_ID.
    if (!config.GROUP_ID) {
        log.debug('DISCOVERY', `chat=${message.from}  author=${message.author}`);
        return;
    }

    // Ignore messages outside the monitored group.
    if (message.from !== config.GROUP_ID) return;

    const chat = await message.getChat();
    if (!chat.isGroup) return;

    const authorId = message.author;
    if (!authorId) return;

    // Resolve a human-friendly display name for the sender (pushname / saved name / number).
    let displayName = authorId.split('@')[0];
    try {
        const contact = await message.getContact();
        displayName = contact.pushname || contact.name || contact.number || displayName;
    } catch (_) { /* fall back to the raw number */ }

    const shortId = authorId.split('@')[0];
    log.event('INGEST', `msg received  ·  from=${log.C.bold}${displayName}${log.C.reset} (${shortId})  type=${message.type}  len=${(message.body || '').length}`);

    // Resolve admin status.
    // Newer WhatsApp uses "@lid" IDs for message.author while chat.participants
    // may use "@c.us". So we match on the numeric part, and cross-check the
    // resolved contact number, to reliably detect admins/owner.
    const authorNum = authorId.split('@')[0];
    let contactNum = null;
    try {
        const c = await message.getContact();
        if (c && c.number) contactNum = String(c.number).replace(/\D/g, '');
    } catch (_) { /* ignore */ }

    const participant = chat.participants.find(p => {
        const pNum = p.id._serialized.split('@')[0];
        return pNum === authorNum || (contactNum && pNum === contactNum);
    });

    // Resolve role from boss/co-admin allowlists (by @lid number or phone number).
    const role = config.roleOf([authorNum, contactNum]);
    const isAdmin = role === 'boss' || role === 'coadmin' ||
        (participant && (participant.isAdmin || participant.isSuperAdmin));

    // ── CORE: Admin "allow" command takes priority over everything else.
    // An admin sends a message containing ALLOW_COMMAND and @mentions the user(s)
    // to grant each a pass. Checked FIRST so the AI talk-back can never hijack it.
    if (isAdmin && message.body.toLowerCase().includes(config.ALLOW_COMMAND.toLowerCase())) {
        // Only treat as the allow command when at least one NON-bot user is mentioned.
        const grantTargets = (message.mentionedIds || [])
            .filter(id => !botNums.has(String(id).split('@')[0]));
        if (grantTargets.length > 0) {
            const names = [];
            for (const grantedTo of grantTargets) {
                passesTracker.grantPass(grantedTo);
                const num = grantedTo.split('@')[0];
                names.push(num);
                log.ok('OVERRIDE', `Operator granted bypass → ${num} (${config.PASS_ALLOWED_MESSAGES} msgs / ${config.PASS_DURATION_MS / 1000}s)`);
            }
            const mins = Math.round(config.PASS_DURATION_MS / 60000);
            await chat.sendMessage(
                `✅ ${names.map(n => '@' + n).join(' ')} you may send up to ${config.PASS_ALLOWED_MESSAGES} messages free of rules within the next ${mins} minutes.`,
                { mentions: grantTargets }
            );
            return;
        }
        // "allow" with no user mentioned → fall through (could just be chatting).
    }

    // ── CORE: Pending kick confirmation. If the boss has a pending kick and
    // says yes/confirm/do it, execute the removal. Checked before talk-back.
    if (role === 'boss' && pendingKicks[authorId]) {
        const pk = pendingKicks[authorId];
        const body = (message.body || '').trim().toLowerCase();
        const yes = /^(yes|y|yep|yeah|confirm|do it|go ahead|kick him|kick her|kick them)\b/.test(body);
        const no = /^(no|n|cancel|stop|nvm|never ?mind|leave (him|her|them))\b/.test(body);

        if (Date.now() > pk.expiry) {
            delete pendingKicks[authorId];
            // expired → fall through and treat message normally
        } else if (yes) {
            delete pendingKicks[authorId];
            try {
                await chat.removeParticipants([pk.targetId]);
                strikesTracker.resetStrikes(pk.targetId);
                await chat.sendMessage(`✅ ${'@' + String(pk.targetId).split('@')[0]} has been removed. As you command, boss. 👑`, { mentions: [pk.targetId] });
                log.ok('COMMAND', `kick confirmed & executed → ${pk.targetId}`);
            } catch (err) {
                await chat.sendMessage('❌ I could not remove them. Make sure I am a group admin.');
                log.error('COMMAND', `kick failed: ${err.message}`);
            }
            return;
        } else if (no) {
            delete pendingKicks[authorId];
            await chat.sendMessage('👍 Cancelled. No one was removed.');
            log.info('COMMAND', 'kick cancelled by boss.');
            return;
        }
        // anything else → let it fall through to normal handling
    }

    // ── Talk-back: anyone who @mentions the bot, replies to it, or says the
    // trigger keyword gets a reply, with tone based on their role. Runs BEFORE
    // moderation, and skips moderation.
    // Mention match: compare against ALL known bot IDs (c.us + @lid).
    const mentionNums = (message.mentionedIds || []).map(id => String(id).split('@')[0]);

    let repliesToBot = false;
    if (message.hasQuotedMsg) {
        try {
            const q = await message.getQuotedMessage();
            if (q.fromMe === true) {
                repliesToBot = true;
                // Self-learn: the quoted (bot) message's author is the bot's @lid.
                const selfId = (q.author || q.from || '').split('@')[0];
                if (selfId && !botNums.has(selfId)) {
                    botNums.add(selfId);
                    log.info('CORE', `Learned bot ID: ${selfId} (now matches @mentions)`);
                }
            } else {
                const qNum = String(q.from).split('@')[0];
                repliesToBot = botNums.has(qNum);
            }
        } catch (_) { /* ignore */ }
    }

    let mentionsBot = mentionNums.some(n => botNums.has(n));

    // Optional keyword trigger — DISABLED when BOT_KEYWORD is empty.
    // The bot now only responds to @mention or reply.
    const kw = config.BOT_KEYWORD;
    const saysKeyword = !!kw && new RegExp(`(^|\\W)${kw}(\\W|$)`, 'i').test(message.body || '');

    if (mentionsBot || repliesToBot || saysKeyword) {
        const trigger = mentionsBot ? 'mention' : repliesToBot ? 'reply' : 'keyword';

        // Admins (boss/co-admin) can issue real commands the bot executes.
        if (role === 'boss' || role === 'coadmin') {
            log.event('TALKBACK', `${displayName} [${role}] gave the bot an instruction (${trigger}). Interpreting...`);
            const cmd = await ai.interpretCommand(message.body);
            const handled = await executeCommand(cmd, chat, message, role);
            if (!handled) {
                // Not an actionable command → fall back to a friendly yes-man reply.
                const reply = (cmd && cmd.text) || await ai.generateReply(message.body, {
                    role, name: displayName, coadminTitle: config.COADMIN_TITLE
                });
                if (reply) {
                    await chat.sendMessage(`@${shortId} ${reply}`, { mentions: [authorId] });
                    log.ok('TALKBACK', `Reply dispatched (${role} tone).`);
                }
            }
            return;
        }

        // Members: CORE rules come first. If their message to the bot breaks a
        // rule, moderate it — do NOT reward rule-breaking with a chat reply.
        const brokenRule = rules.find(r => r.check(message.body, message));
        if (brokenRule) {
            log.warn('TALKBACK', `${displayName} broke "${brokenRule.name}" while addressing the bot — moderating instead of replying.`);
            await enforceViolation(brokenRule, message, chat, authorId, displayName, shortId);
            return;
        }

        // Clean message → savage reply with a correct big-boss tag.
        log.event('TALKBACK', `${displayName} [member] addressed the bot (${trigger}). Generating clapback...`);
        const reply = await ai.generateReply(message.body, {
            role, name: displayName, coadminTitle: config.COADMIN_TITLE, bossName: config.BOSS_NAME
        });
        if (reply) {
            const bossPhone = config.BOSS_PHONE;
            const bossTag = bossPhone ? ` (@${bossPhone} is the big boss 👑)` : '';
            const mentions = bossPhone ? [authorId, `${bossPhone}@c.us`] : [authorId];
            await chat.sendMessage(`@${shortId} ${reply}${bossTag}`, { mentions });
            log.ok('TALKBACK', 'Clapback dispatched (member tone).');
        } else {
            log.warn('TALKBACK', 'No AI output — skipping reply.');
        }
        return;
    }

    if (isAdmin) {
        log.debug('FILTER', `${displayName} is operator/admin — bypassing ruleset.`);
        return;
    }

    // Honor an active pass: skip the ruleset and decrement the message count.
    if (passesTracker.hasPass(authorId)) {
        const left = passesTracker.usePass(authorId);
        const secsLeft = passesTracker.timeLeft(authorId);
        log.warn('OVERRIDE', `${displayName} used a bypass message — ruleset skipped (${left} msg / ${secsLeft}s left).`);
        return;
    }

    // Run the ruleset.
    const tripped = rules.find(r => r.check(message.body, message));
    if (tripped) {
        await enforceViolation(tripped, message, chat, authorId, displayName, shortId);
    }
});

// Enforce a single rule violation: delete, strike, warn-with-roast, or kick.
async function enforceViolation(rule, message, chat, authorId, displayName, shortId) {
    log.warn('VIOLATION', `${log.C.bold}${displayName}${log.C.reset} (${shortId}) tripped rule "${log.C.yellow}${rule.name}${log.C.reset}"`);
    try {
        await message.delete(true);
        log.ok('ENFORCE', `Offending message purged for all participants.`);

        const currentStrikes = strikesTracker.addStrike(authorId);
        const userNumber = authorId.split('@')[0];
        log.info('STRIKE', `${displayName} (${shortId}) → strike ${log.C.bold}${currentStrikes}/${config.MAX_STRIKES}${log.C.reset}`);

        if (currentStrikes < config.MAX_STRIKES) {
            log.info('LLM', 'Requesting savage roast from Groq inference endpoint...');
            const roast = await ai.generateRoast(rule.reason, {
                kicked: false,
                strike: currentStrikes,
                maxStrikes: config.MAX_STRIKES,
                name: displayName
            });

            let warnMsg;
            if (roast) {
                log.ok('LLM', `Roast generated (${roast.length} chars).`);
                warnMsg = `@${userNumber} ${roast} (strike ${currentStrikes}/${config.MAX_STRIKES})`;
            } else {
                log.warn('LLM', 'No AI output — falling back to template warning.');
                warnMsg = config.WARN_MESSAGE
                    .replace('{user}', userNumber)
                    .replace('{reason}', rule.reason)
                    .replace('{currentStrike}', currentStrikes)
                    .replace('{maxStrikes}', config.MAX_STRIKES);
            }

            await chat.sendMessage(warnMsg, { mentions: [authorId] });
            log.ok('ENFORCE', `Warning dispatched to group.`);
        } else {
            log.warn('ENFORCE', `Strike threshold reached — initiating removal of ${displayName} (${shortId}).`);
            log.info('LLM', 'Requesting farewell roast from Groq inference endpoint...');
            const roast = await ai.generateRoast(rule.reason, { kicked: true, name: displayName });

            let kickMsg = roast
                ? `@${userNumber} ${roast}`
                : config.KICK_MESSAGE.replace('{user}', userNumber);

            await chat.sendMessage(kickMsg, { mentions: [authorId] });
            await chat.removeParticipants([authorId]);
            strikesTracker.resetStrikes(authorId);
            log.ok('ENFORCE', `${log.C.bold}${displayName} (${shortId}) removed from group. Strike counter reset.${log.C.reset}`);
        }
    } catch (err) {
        log.error('ENFORCE', `Action failed for ${shortId}: ${err.message}`);
    }
}

// ── Start ──────────────────────────────────────────────────────
log.info('CORE', 'Initializing WhatsApp Web client (Puppeteer/Chromium)...');
client.initialize();
