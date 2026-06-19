// Groq-powered sarcastic roast generator.
// Falls back to plain templates if the API key is missing or a call fails,
// so the bot never breaks because of the AI.
require('dotenv').config();
const Groq = require('groq-sdk');

const apiKey = process.env.GROQ_API_KEY;
const client = apiKey ? new Groq({ apiKey }) : null;

// Model is configurable via .env; defaults to a fast, capable Groq model.
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT =
    'You are a savage, witty WhatsApp group moderator bot. A member just broke a ' +
    'group rule. Roast them with sharp, savage sarcasm in ONE short line (max 25 words). ' +
    'Be funny and biting, but NEVER use slurs, profanity, hate speech, or attacks on ' +
    'protected characteristics. Do not add quotes around your reply. Do not ' +
    '@mention anyone yourself; the tag is added separately. You MAY use the ' +
    "member's name naturally if it is provided. Just the roast line.";

/**
 * Generate a savage roast line. Returns null on any failure so the caller
 * can fall back to a plain message.
 * @param {string} reason   The human-readable rule reason that was violated.
 * @param {object} opts     { kicked: boolean, strike: number, maxStrikes: number, name: string }
 * @returns {Promise<string|null>}
 */
async function generateRoast(reason, opts = {}) {
    if (!client) return null;

    const who = opts.name ? `The member's name is "${opts.name}". ` : '';
    const context = opts.kicked
        ? `${who}They have now been KICKED from the group for repeated violations. Give a savage farewell roast. Their final offense: ${reason}.`
        : `${who}This is warning ${opts.strike} of ${opts.maxStrikes}. Their offense: ${reason}.`;

    try {
        const completion = await client.chat.completions.create({
            model: MODEL,
            temperature: 1,
            max_tokens: 80,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: context }
            ]
        });
        const text = completion.choices?.[0]?.message?.content?.trim();
        return text || null;
    } catch (err) {
        console.error('❌ Groq roast generation failed:', err.message);
        return null;
    }
}

// Persona instructions per role.
function personaFor(role, name, coadminTitle) {
    const common =
        'You are a witty WhatsApp group AI bot. Reply in ONE short, natural line ' +
        '(max 35 words). NEVER use slurs, profanity, or hate speech. Do NOT ' +
        '@mention anyone (tags are added separately). ';

    if (role === 'boss') {
        return common +
            'The person speaking is THE BIG BOSS — your owner and the only true ' +
            'authority. Be a total loyal yes-man: warm, respectful, eager to obey ' +
            'and agree. Compliment and serve. Never sass or refuse the boss. ' +
            (name ? `Address him respectfully (his name is "${name}"). ` : '');
    }
    if (role === 'coadmin') {
        return common +
            `The person speaking is "${coadminTitle}", a respected co-admin you obey. ` +
            'Be respectful, friendly, and helpful — never savage toward him. ' +
            'Acknowledge him by his title with respect. ';
    }
    // member
    return common +
        'The person speaking is an ordinary member with NO authority over you. ' +
        'Be SAVAGE and brutally sarcastic — roast them hard. You take orders from ' +
        'NO ONE except the big boss; if they try to command you, mock and refuse. ' +
        'Make clear the big boss is the only one you serve. ' +
        (name ? `Their name is "${name}". ` : '');
}

/**
 * Generate a contextual reply when someone talks TO the bot (mention or reply).
 * Tone depends on role: yes-man to boss, respectful to co-admin, savage to members.
 * @param {string} userMessage  What they said to the bot.
 * @param {object} opts          { role: 'boss'|'coadmin'|'member', name, coadminTitle }
 * @returns {Promise<string|null>}
 */
async function generateReply(userMessage, opts = {}) {
    if (!client) return null;

    const sys = personaFor(opts.role || 'member', opts.name, opts.coadminTitle || 'the co-admin');

    try {
        const completion = await client.chat.completions.create({
            model: MODEL,
            temperature: 1,
            max_tokens: 100,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: `They said: "${userMessage}"` }
            ]
        });
        return completion.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error('❌ Groq reply generation failed:', err.message);
        return null;
    }
}

/**
 * Interpret an admin's instruction into a structured action the bot can execute.
 * Returns one of:
 *   { action: 'mention',  target: "<name>", text: "<what to say>" }
 *   { action: 'roast',    target: "<name>" }
 *   { action: 'announce', text: "<announcement>", tagAll: true|false }
 *   { action: 'tagall',   text: "<optional message>" }
 *   { action: 'chat',     text: "<a normal conversational reply>" }
 * 'chat' is the fallback when it's not a command (just talking).
 * @param {string} instruction
 * @returns {Promise<object|null>}
 */
async function interpretCommand(instruction) {
    if (!client) return null;

    const sys =
        'You are the command parser for a WhatsApp group bot, controlled by an admin. ' +
        'Read the admin\'s message and output ONLY a JSON object (no prose, no code fences) ' +
        'describing the action. Valid shapes:\n' +
        '{"action":"mention","target":"<person name>","text":"<message to send them>"}\n' +
        '{"action":"roast","target":"<person name>"}\n' +
        '{"action":"announce","text":"<announcement text>","tagAll":false}\n' +
        '{"action":"tagall","text":"<optional message>"}\n' +
        '{"action":"chat","text":"<a short friendly reply as a loyal yes-man>"}\n' +
        'Use "mention" when the admin wants someone tagged and told something. ' +
        'Use "roast" when the admin wants someone mocked/teased. ' +
        'Use "announce" for broadcasts; set tagAll true only if they want everyone notified. ' +
        'Use "tagall" when they explicitly want every member tagged. ' +
        'If it is just conversation (no actionable command), use "chat". ' +
        'Extract the person\'s name into "target" exactly as the admin referred to them. ' +
        'Output strictly valid JSON.';

    try {
        const completion = await client.chat.completions.create({
            model: MODEL,
            temperature: 0.4,
            max_tokens: 200,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: instruction }
            ]
        });
        const raw = completion.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.error('❌ Groq command interpretation failed:', err.message);
        return null;
    }
}

/**
 * Generate a savage roast aimed at a named person, on command.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function roastPerson(name) {
    if (!client) return null;
    try {
        const completion = await client.chat.completions.create({
            model: MODEL,
            temperature: 1,
            max_tokens: 80,
            messages: [
                {
                    role: 'system',
                    content: 'You are a savage WhatsApp bot. Roast the named person in ONE ' +
                        'short brutal line (max 25 words). No slurs/profanity/hate speech. ' +
                        'Do not @mention; the tag is added separately.'
                },
                { role: 'user', content: `Roast this person: ${name}` }
            ]
        });
        return completion.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error('❌ Groq roastPerson failed:', err.message);
        return null;
    }
}

module.exports = { generateRoast, generateReply, interpretCommand, roastPerson };
