// Sends e-mail through SMTP when `nodemailer` is installed and SMTP_HOST is set.
// Otherwise the message is printed to the server log (development) - nothing is lost silently.
let transporter = null;
try {
    if (process.env.SMTP_HOST) {
        const nodemailer = require('nodemailer');
        const port = parseInt(process.env.SMTP_PORT, 10) || 587;
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: port === 465,
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        });
    }
} catch (e) {
    console.warn('⚠️  SMTP_HOST is set but nodemailer is not installed (run: npm install). E-mails will only be logged.');
}

async function sendMail({ to, subject, text }) {
    if (!transporter) {
        console.log(`\n[MAIL - SMTP not configured, printing instead]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
        return { sent: false };
    }
    try {
        await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
        return { sent: true };
    } catch (err) {
        console.error('❌ Could not send e-mail:', err.message);
        return { sent: false, error: err.message };
    }
}

module.exports = { sendMail };
