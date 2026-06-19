// Lightweight structured logger with ANSI colors, timestamps, and levels.
// Designed to look like a production service log (great for demos/recordings).

const C = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    gray: '\x1b[90m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

function ts() {
    // ISO-like timestamp with milliseconds: 2026-06-19 14:32:07.412
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function line(levelLabel, levelColor, scope, msg) {
    const time = `${C.gray}${ts()}${C.reset}`;
    const level = `${levelColor}${C.bold}${levelLabel.padEnd(5)}${C.reset}`;
    const tag = scope ? `${C.cyan}[${scope}]${C.reset} ` : '';
    return `${time} ${level} ${tag}${msg}`;
}

const logger = {
    info: (scope, msg) => console.log(line('INFO', C.blue, scope, msg)),
    ok: (scope, msg) => console.log(line('OK', C.green, scope, msg)),
    warn: (scope, msg) => console.log(line('WARN', C.yellow, scope, msg)),
    error: (scope, msg) => console.log(line('ERROR', C.red, scope, msg)),
    debug: (scope, msg) => console.log(line('DEBUG', C.magenta, scope, `${C.dim}${msg}${C.reset}`)),
    event: (scope, msg) => console.log(line('EVENT', C.cyan, scope, msg)),

    banner: () => {
        const b = C.cyan + C.bold;
        console.log('');
        console.log(b + '  ╔══════════════════════════════════════════════════════╗' + C.reset);
        console.log(b + '  ║        WhatsApp Moderation Engine  ·  v1.0.0          ║' + C.reset);
        console.log(b + '  ║        Node.js · whatsapp-web.js · Groq LLM          ║' + C.reset);
        console.log(b + '  ╚══════════════════════════════════════════════════════╝' + C.reset);
        console.log('');
    },

    C
};

module.exports = logger;
