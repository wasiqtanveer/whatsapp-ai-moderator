// Tracks timed "free pass" grants for users.
// When an admin sends "allow @user", that user skips rule checks for up to
// PASS_ALLOWED_MESSAGES messages, within PASS_DURATION_MS (e.g. 5 minutes).
// Whichever limit is hit first ends the pass.
const config = require('./config');

// Map of userId -> { expiry: timestamp(ms), remaining: number }
const passes = {};

module.exports = {
    /**
     * Grant a pass: N messages valid until now + PASS_DURATION_MS.
     * @param {string} userId
     */
    grantPass: (userId) => {
        passes[userId] = {
            expiry: Date.now() + config.PASS_DURATION_MS,
            remaining: config.PASS_ALLOWED_MESSAGES
        };
    },

    /**
     * Is there a valid pass (not expired, messages left)?
     * @param {string} userId
     * @returns {boolean}
     */
    hasPass: (userId) => {
        const p = passes[userId];
        if (!p) return false;
        if (Date.now() > p.expiry || p.remaining <= 0) {
            delete passes[userId];
            return false;
        }
        return true;
    },

    /**
     * Use one message of the pass. Returns messages remaining AFTER this use.
     * Deletes the pass when it hits zero.
     * @param {string} userId
     * @returns {number}
     */
    usePass: (userId) => {
        const p = passes[userId];
        if (!p) return 0;
        p.remaining -= 1;
        const left = p.remaining;
        if (left <= 0) delete passes[userId];
        return Math.max(0, left);
    },

    /**
     * Seconds remaining on a user's pass (0 if none/expired).
     * @param {string} userId
     * @returns {number}
     */
    timeLeft: (userId) => {
        const p = passes[userId];
        if (!p) return 0;
        return Math.max(0, Math.ceil((p.expiry - Date.now()) / 1000));
    }
};
