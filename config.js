require('dotenv').config();

const csv = (v) => (v || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);

// ── Roles ──────────────────────────────────────────────────────
// BOSS: the big boss — bot is a total yes-man and obeys only this person (+ co-admins).
// CO_ADMINS: Arsalan "MPA Saib" — respected and can command the bot.
const BOSS_IDS = csv(process.env.BOSS_IDS);
const COADMIN_IDS = csv(process.env.COADMIN_IDS);

module.exports = {
    // If GROUP_ID is empty, the bot will print all incoming message IDs to the terminal
    // so you can find the group ID and paste it here.
    GROUP_ID: process.env.GROUP_ID || '',

    BOSS_IDS,
    COADMIN_IDS,
    // Display title for the co-admin (Arsalan).
    COADMIN_TITLE: process.env.COADMIN_TITLE || 'Arsalan MPA Saib',

    // Everyone who can command the bot / bypass rules (boss + co-admins).
    ADMIN_IDS: [...BOSS_IDS, ...COADMIN_IDS],

    // Number of strikes before kicking a user
    MAX_STRIKES: 3,

    // Maximum allowed message length (characters). Longer messages are a violation.
    MAX_MESSAGE_LENGTH: 300,

    // Admin keyword: when an admin sends a message containing this word AND
    // @mentions one or more users, each mentioned user gets a one-time free pass.
    // Example:  allow @user
    ALLOW_COMMAND: 'allow',

    // Optional keyword trigger (in addition to @mention/reply). Leave EMPTY to
    // disable — the bot then only responds to @mention or reply.
    BOT_KEYWORD: process.env.BOT_KEYWORD || '',

    // Known IDs of the bot itself (numeric). The bot's @c.us is detected
    // automatically; add its @lid here so @mentions of the bot are recognized.
    BOT_IDS: csv(process.env.BOT_IDS),

    // How long a granted free pass stays valid before it expires (milliseconds).
    PASS_DURATION_MS: 5 * 60 * 1000, // 5 minutes

    // How many messages a pass covers within that window (whichever ends first).
    PASS_ALLOWED_MESSAGES: 3,
    
    // Warning message to send to the group
    WARN_MESSAGE: '@{user}, you violated a rule: {reason}. Warning {currentStrike}/{maxStrikes}.',
    
    // Message to send before removing the user
    KICK_MESSAGE: '@{user} has been removed for repeatedly violating the rules.',

    /**
     * Resolve a user's role from their possible IDs (any of: @lid number,
     * phone number). Returns 'boss' | 'coadmin' | 'member'.
     * @param {string[]} candidateNums  numeric IDs to test (digits only)
     */
    roleOf: (candidateNums) => {
        const nums = candidateNums.filter(Boolean);
        if (nums.some(n => BOSS_IDS.includes(n))) return 'boss';
        if (nums.some(n => COADMIN_IDS.includes(n))) return 'coadmin';
        return 'member';
    }
};