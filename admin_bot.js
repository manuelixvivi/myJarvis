require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const crypto = require('crypto');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const bot = new Telegraf(ADMIN_BOT_TOKEN);

const dbPath = './database.json';

// Inisialisasi DB jika kosong atau formatnya salah
const initDb = () => {
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify({ users: {}, tokens: {} }, null, 2));
    } else {
        try {
            const data = JSON.parse(fs.readFileSync(dbPath));
            if(!data.users || !data.tokens) {
                fs.writeFileSync(dbPath, JSON.stringify({ users: data.users || {}, tokens: data.tokens || {} }, null, 2));
            }
        } catch (e) {
            fs.writeFileSync(dbPath, JSON.stringify({ users: {}, tokens: {} }, null, 2));
        }
    }
};
initDb();

const getDb = () => JSON.parse(fs.readFileSync(dbPath));
const saveDb = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

// Middleware keamanan (Hanya admin yang bisa akses)
bot.use((ctx, next) => {
    if (ctx.from?.id.toString() !== ADMIN_CHAT_ID) {
        ctx.reply("❌ Anda bukan Admin.");
        return;
    }
    return next();
});

bot.start((ctx) => {
    const welcomeMsg = `👑 *Sistem Admin JARVIS SaaS*\n\nSelamat datang, Admin. Gunakan command berikut:\n\n/generate - Buat Token Aktivasi baru untuk Klien.\n/status - Lihat daftar token dan user.`;
    ctx.replyWithMarkdown(welcomeMsg);
});

// Command untuk membuat Token Aktivasi
bot.command('generate', (ctx) => {
    const db = getDb();
    
    // Generate random 8 character string
    const newToken = 'JARVIS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    
    db.tokens[newToken] = {
        used: false,
        generatedAt: new Date().toISOString(),
        usedBy: null
    };
    saveDb(db);
    
    ctx.replyWithMarkdown(`✅ **Token Berhasil Dibuat!**\n\n\`${newToken}\`\n\nBerikan token di atas kepada Klien Anda agar mereka bisa mendaftar di Bot User.`);
});

// Command untuk melihat status
bot.command('status', (ctx) => {
    const db = getDb();
    
    const tokens = Object.keys(db.tokens);
    const unusedTokens = tokens.filter(t => !db.tokens[t].used);
    const usedTokens = tokens.filter(t => db.tokens[t].used);
    
    const usersCount = Object.keys(db.users).length;
    
    let msg = `📊 *Status Sistem JARVIS SaaS*\n\n`;
    msg += `👥 **Total Pengguna Aktif:** ${usersCount} orang\n`;
    msg += `🎟 **Total Token:** ${tokens.length}\n`;
    msg += `✅ **Token Terpakai:** ${usedTokens.length}\n`;
    msg += `🟢 **Token Tersedia:** ${unusedTokens.length}\n\n`;
    
    if (unusedTokens.length > 0) {
        msg += `*Daftar Token Tersedia (Unused):*\n`;
        unusedTokens.forEach(t => {
            msg += `- \`${t}\`\n`;
        });
    }

    ctx.replyWithMarkdown(msg);
});

bot.launch().then(() => {
    console.log('👑 Admin Bot berhasil dijalankan!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
