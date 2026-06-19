const config = require('./config');

module.exports = [
    {
        name: 'No Media',
        check: (messageText, messageObj) => {
            // Block any media: images, video, stickers, gifs, audio/voice, documents.
            // hasMedia covers most attachments; type covers stickers/gifs and other cases.
            const blockedTypes = ['image', 'video', 'sticker', 'audio', 'ptt', 'document', 'gif'];
            return messageObj.hasMedia === true || blockedTypes.includes(messageObj.type);
        },
        reason: 'Sending images, videos, stickers, GIFs, audio, or documents is not allowed'
    },
    {
        name: 'Max Length',
        check: (messageText, messageObj) => {
            return typeof messageText === 'string' && messageText.length > config.MAX_MESSAGE_LENGTH;
        },
        reason: `Messages must be ${config.MAX_MESSAGE_LENGTH} characters or fewer`
    },
    {
        name: 'No URLs',
        check: (messageText, messageObj) => {
            // Check for http, https, or www
            const urlRegex = /(http|https|www\.)/i;
            return urlRegex.test(messageText);
        },
        reason: 'Sending URLs or links is not allowed'
    },
    {
        name: 'No Forwarded Messages',
        check: (messageText, messageObj) => {
            // Check if the message object has the isForwarded flag set to true
            return messageObj.isForwarded === true;
        },
        reason: 'Forwarded messages are not allowed'
    },
    {
        name: 'No All-Caps',
        check: (messageText, messageObj) => {
            // Remove non-letter characters
            const lettersOnly = messageText.replace(/[^a-zA-Z]/g, '');
            // Check if the message contains more than 10 letters and is entirely uppercase
            return lettersOnly.length > 10 && lettersOnly === lettersOnly.toUpperCase();
        },
        reason: 'Excessive use of capitals is not allowed'
    }
];
