// Simple in-memory strike tracker
const strikes = {};

module.exports = {
    /**
     * Adds a strike to the participant and returns the new strike count.
     * @param {string} participantId 
     * @returns {number}
     */
    addStrike: (participantId) => {
        if (!strikes[participantId]) {
            strikes[participantId] = 0;
        }
        strikes[participantId] += 1;
        return strikes[participantId];
    },

    /**
     * Returns the current strike count for a participant.
     * @param {string} participantId 
     * @returns {number}
     */
    getStrikes: (participantId) => {
        return strikes[participantId] || 0;
    },

    /**
     * Resets the strikes for a participant to 0.
     * @param {string} participantId 
     */
    resetStrikes: (participantId) => {
        strikes[participantId] = 0;
    }
};