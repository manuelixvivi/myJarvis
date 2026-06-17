require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const WebSocket = require('ws');

// --- DATABASE SETUP ---
const dbPath = './database.json';
const getDb = () => {
    try { return JSON.parse(fs.readFileSync(dbPath)); } 
    catch (e) { return { users: {}, tokens: {} }; }
};
const saveDb = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

// --- WEBSOCKET SERVER (SaaS CONNECTION) ---
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const connectedLaptops = {}; // chatId -> WebSocket
const pairingPins = {}; // pin -> WebSocket

wss.on('connection', (ws) => {
    console.log("💻 Sebuah Laptop Klien Baru Terhubung (Pending Auth)...");
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.action === 'init_pairing') {
                pairingPins[data.pin] = { ws, deviceId: data.deviceId };
                console.log(`Menunggu user Telegram dengan PIN: ${data.pin}`);
            } 
            else if (data.action === 'register') {
                if (!connectedLaptops[data.chatId]) connectedLaptops[data.chatId] = {};
                connectedLaptops[data.chatId][data.deviceId] = ws;
                console.log(`✅ Laptop [${data.deviceId}] untuk Chat ID ${data.chatId} Terhubung!`);
                ws.chatId = data.chatId;
                ws.deviceId = data.deviceId;
            }
            else if (data.action === 'screenshot_result') {
                const buffer = Buffer.from(data.image, 'base64');
                bot.telegram.sendPhoto(ws.chatId, { source: buffer }, { caption: `📸 *Tangkapan dari [${ws.deviceId}]*`, parse_mode: 'Markdown' });
            }
        } catch (e) {
            console.error("Invalid WS Message", e);
        }
    });

    ws.on('close', () => {
        if(ws.chatId && ws.deviceId && connectedLaptops[ws.chatId]) {
            delete connectedLaptops[ws.chatId][ws.deviceId];
        }
        console.log("Koneksi laptop terputus.");
    });
});

// --- TELEGRAM BOT ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const sendMainMenu = (ctx) => {
    const userName = ctx.from?.first_name || 'Boss';
    const db = getDb();
    const chatId = ctx.chat.id.toString();
    const user = db.users[chatId];
    
    const balance = user && user.finances ? user.finances.balance : 0;
    const balanceStr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(balance);
    
    const welcomeMessage = `Selamat datang kembali, *${userName}*.\n\nSistem JARVIS online.\n💰 Saldo Anda: ${balanceStr}\n\nApa yang ingin Anda lakukan?`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 Keuangan & Laporan', 'MENU_FINANCE'), Markup.button.callback('📅 Sekretaris (To-Do)', 'MENU_SECRETARY')],
        [Markup.button.callback('🧘‍♂️ Cek Stres & Mood', 'MENU_WELLBEING'), Markup.button.callback('💻 Kontrol PC (SaaS)', 'MENU_SYSTEM')],
        [Markup.button.callback('🧠 Tanya JARVIS (Gemini AI)', 'MENU_AI')]
    ]);

    ctx.replyWithMarkdown(welcomeMessage, keyboard);
};

// Command Pairing
bot.command('pair', (ctx) => {
    const chatId = ctx.chat.id.toString();
    const db = getDb();
    if (!db.users || !db.users[chatId] || !db.users[chatId].isRegistered) {
        return ctx.reply("❌ Anda belum terdaftar di sistem. Gunakan /start terlebih dahulu.");
    }

    const pin = ctx.message.text.split(' ')[1];
    const pinData = pairingPins[pin];
    if (!pin || !pinData) {
        return ctx.reply("❌ PIN tidak valid atau Laptop belum menyala.");
    }

    // Sambungkan
    const ws = pinData.ws;
    const deviceId = pinData.deviceId;
    
    if (!connectedLaptops[chatId]) connectedLaptops[chatId] = {};
    connectedLaptops[chatId][deviceId] = ws;
    ws.chatId = chatId;
    ws.deviceId = deviceId;
    
    ws.send(JSON.stringify({ action: 'paired', chatId: chatId }));
    delete pairingPins[pin];

    ctx.reply(`✅ **Pairing Sukses!**\n\nLaptop [${deviceId}] terhubung eksklusif dengan Telegram Anda.`);
});

// Command Unpair
bot.command('unpair', (ctx) => {
    const chatId = ctx.chat.id.toString();
    const devices = connectedLaptops[chatId] || {};
    
    if (Object.keys(devices).length === 0) {
        return ctx.reply("❌ Tidak ada laptop yang terhubung ke akun Anda saat ini.");
    }
    
    // Kirim perintah unpair ke SEMUA laptop
    Object.values(devices).forEach(ws => {
        ws.send(JSON.stringify({ command: 'UNPAIR' }));
    });
    
    delete connectedLaptops[chatId];
    ctx.reply("✅ **Unpair Massal Sukses!**\n\nSeluruh koneksi laptop Anda telah diputuskan.");
});

bot.start((ctx) => {
    const chatId = ctx.chat.id.toString();
    const db = getDb();

    if (db.users && db.users[chatId] && db.users[chatId].isRegistered) {
        sendMainMenu(ctx);
    } else {
        ctx.session = ctx.session || {};
        ctx.session.step = 'WAITING_TOKEN';
        ctx.replyWithMarkdown(`Halo! Saya **JARVIS**.\n\nSilakan masukkan **Token Aktivasi** eksklusif yang diberikan oleh Admin:`);
    }
});

bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const text = ctx.message.text.trim();
    if(text.startsWith('/')) return;
    const db = getDb();
    
    if (db.users && db.users[chatId] && db.users[chatId].isRegistered) {
        const step = ctx.session?.step;
        if (step === 'INPUT_INCOME') {
            const amount = parseInt(text.replace(/[^0-9]/g, ''));
            if(amount) {
                if(!db.users[chatId].finances) db.users[chatId].finances = {balance:0, income_total:0, expense_total:0};
                db.users[chatId].finances.balance += amount;
                db.users[chatId].finances.income_total = (db.users[chatId].finances.income_total || 0) + amount;
                saveDb(db);
                ctx.session.step = null;
                ctx.reply(`✅ Pemasukan Rp${amount.toLocaleString('id-ID')} berhasil dicatat!`);
                sendMainMenu(ctx);
            } else {
                ctx.reply("Angka tidak valid. Masukkan nominal angka saja (misal: 50000).");
            }
            return;
        }
        
        if (step === 'INPUT_EXPENSE') {
            const amount = parseInt(text.replace(/[^0-9]/g, ''));
            if(amount) {
                if(!db.users[chatId].finances) db.users[chatId].finances = {balance:0, income_total:0, expense_total:0};
                db.users[chatId].finances.balance -= amount;
                db.users[chatId].finances.expense_total = (db.users[chatId].finances.expense_total || 0) + amount;
                saveDb(db);
                ctx.session.step = null;
                ctx.reply(`✅ Pengeluaran Rp${amount.toLocaleString('id-ID')} berhasil dicatat!`);
                sendMainMenu(ctx);
            } else {
                ctx.reply("Angka tidak valid. Masukkan nominal angka saja (misal: 50000).");
            }
            return;
        }

        const userApiKey = db.users[chatId].geminiApiKey;
        try {
            await ctx.sendChatAction('typing');
            const ai = new GoogleGenAI({ apiKey: userApiKey });
            
            const f = db.users[chatId].finances || {balance:0, income_total:0, expense_total:0};
            if(!db.users[chatId].history) db.users[chatId].history = [];
            
            db.users[chatId].history.push(`Boss: ${text}`);
            if(db.users[chatId].history.length > 10) db.users[chatId].history.shift();
            const historyText = db.users[chatId].history.join("\n");

            const prompt = `Kamu adalah JARVIS, asisten AI pribadi yang cerdas dan mengelola keuangan Boss. Panggil user 'Boss'. 
Kamu MEMILIKI akses penuh ke database keuangan Boss. Ini adalah data keuangan Boss yang aktual di sistem saat ini:
- Saldo Bersih: Rp${f.balance.toLocaleString('id-ID')}
- Total Pemasukan: Rp${f.income_total.toLocaleString('id-ID')}
- Total Pengeluaran: Rp${f.expense_total.toLocaleString('id-ID')}

Berikut adalah riwayat percakapan kalian sebelumnya (ingat konteks utang, piutang, atau topik lain di sini):
${historyText}

ATURAN PENTING:
1. Jika Boss bertanya tentang keuangannya, JAWAB DENGAN PERCAYA DIRI berdasarkan Data Saldo dan Riwayat di atas. JANGAN PERNAH bilang kamu tidak punya akses atau tidak tahu. Kamu adalah pengelola databasenya!
2. Jika Boss menyuruhmu mencatat transaksi keuangan BARU (menambah/mengurangi uang), kamu WAJIB menyisipkan teks JSON murni ini tepat di baris paling akhir jawabanmu: 
{"action": "income", "amount": 5000} ATAU {"action": "expense", "amount": 5000}.
Ganti 5000 dengan nominal angka yang disebutkan. JANGAN gunakan koma atau titik pada angka di dalam JSON.

ATURAN LOGIKA AKUNTANSI (SANGAT KRITIKAL):
- Jika Boss "Meminjam uang / Berhutang" ke orang lain -> Kas bertambah -> Gunakan action "income".
- Jika Boss "Membayar hutang" ke orang lain -> Kas berkurang -> Gunakan action "expense".
- Jika Boss "Meminjamkan uang / Memberi hutang" ke orang lain -> Kas berkurang -> Gunakan action "expense".
- Jika Boss "Menerima pelunasan hutang" dari orang lain -> Kas bertambah -> Gunakan action "income".

Jika tidak ada transaksi baru (hanya bertanya saldo), JANGAN KELUARKAN JSON APAPUN.

Jawablah sekarang merespons kalimat terakhir Boss.`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            
            let aiText = response.text;
            
            const jsonMatch = aiText.match(/\{ *"action" *: *"(income|expense)" *, *"amount" *: *(\d+) *\}/i);
            if (jsonMatch) {
                const action = jsonMatch[1].toLowerCase();
                const amount = parseInt(jsonMatch[2]);
                if(!db.users[chatId].finances) db.users[chatId].finances = {balance:0, income_total:0, expense_total:0};
                
                if (action === 'income') {
                    db.users[chatId].finances.balance += amount;
                    db.users[chatId].finances.income_total = (db.users[chatId].finances.income_total || 0) + amount;
                } else {
                    db.users[chatId].finances.balance -= amount;
                    db.users[chatId].finances.expense_total = (db.users[chatId].finances.expense_total || 0) + amount;
                }
                
                aiText = aiText.replace(jsonMatch[0], '').trim();
                aiText += `\n\n*(Sistem JARVIS: Database Keuangan berhasil diperbarui secara otomatis. Saldo Anda sekarang: Rp${db.users[chatId].finances.balance.toLocaleString('id-ID')})*`;
            }
            
            db.users[chatId].history.push(`JARVIS: ${aiText.replace(/\n/g, ' ')}`);
            if(db.users[chatId].history.length > 10) db.users[chatId].history.shift();
            saveDb(db);
            
            ctx.reply(aiText);
        } catch (error) {
            console.error(error);
            ctx.reply("❌ Gagal terhubung ke Gemini API.");
        }
        return;
    }

    const step = ctx.session?.step;
    if (step === 'WAITING_TOKEN') {
        if (db.tokens && db.tokens[text] && db.tokens[text].used === false) {
            ctx.session.validToken = text;
            ctx.session.step = 'WAITING_API_KEY';
            ctx.replyWithMarkdown(`✅ **Token Valid!**\nSilakan paste API Key Gemini gratis Anda dari Google AI Studio:`);
        } else {
            ctx.reply("❌ Token tidak valid.");
        }
    } 
    else if (step === 'WAITING_API_KEY') {
        if (text.length > 20) {
            const tokenUsed = ctx.session.validToken;
            if(db.tokens[tokenUsed]) { db.tokens[tokenUsed].used = true; db.tokens[tokenUsed].usedBy = chatId; }

            if(!db.users) db.users = {};
            db.users[chatId] = { isRegistered: true, geminiApiKey: text, finances: {balance:0} };
            saveDb(db);
            ctx.session.step = null;
            ctx.replyWithMarkdown(`🎉 **Aktivasi Berhasil Sempurna!**`);
            sendMainMenu(ctx);
        }
    }
});

bot.action('MENU_FINANCE', (ctx) => {
    const msg = `*Modul Keuangan Aktif*\nSilakan pilih menu pencatatan:`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Tambah Pemasukan', 'FINANCE_INCOME'), Markup.button.callback('➖ Tambah Pengeluaran', 'FINANCE_EXPENSE')],
        [Markup.button.callback('📈 Generate Laporan Keuangan', 'FINANCE_REPORT')],
        [Markup.button.callback('🔙 Kembali ke Menu Utama', 'BACK_MAIN')]
    ]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('FINANCE_INCOME', (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.step = 'INPUT_INCOME';
    ctx.reply("Berapa jumlah pemasukan Anda? (Ketik angka saja, misal: 150000)");
});

bot.action('FINANCE_EXPENSE', (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.step = 'INPUT_EXPENSE';
    ctx.reply("Berapa jumlah pengeluaran Anda? (Ketik angka saja, misal: 50000)");
});

bot.action('FINANCE_REPORT', (ctx) => {
    const chatId = ctx.chat.id.toString();
    const f = getDb().users[chatId].finances || {balance:0, income_total:0, expense_total:0};
    const chartUrl = `https://quickchart.io/chart?c={type:'doughnut',data:{labels:['Pemasukan','Pengeluaran'],datasets:[{data:[${f.income_total},${f.expense_total}],backgroundColor:['green','red']}]}}`;
    const msg = `📊 **Laporan Keuangan Anda:**\n\nTotal Pemasukan: Rp${(f.income_total||0).toLocaleString('id-ID')}\nTotal Pengeluaran: Rp${(f.expense_total||0).toLocaleString('id-ID')}\n**Saldo Bersih: Rp${(f.balance||0).toLocaleString('id-ID')}**`;
    ctx.replyWithPhoto({ url: chartUrl }, { caption: msg, parse_mode: 'Markdown' });
});

bot.action('MENU_SECRETARY', (ctx) => {
    const msg = `*📅 Modul Sekretaris Pribadi*\nSemua tugas dan deadline Anda tercatat di sini.`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📝 Tambah To-Do List', 'TODO_ADD'), Markup.button.callback('📋 Lihat Semua Tugas', 'TODO_LIST')],
        [Markup.button.callback('🔙 Kembali ke Menu Utama', 'BACK_MAIN')]
    ]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});
bot.action('TODO_ADD', (ctx) => ctx.answerCbQuery("Fitur 'Tambah To-Do List' sedang dalam pengembangan!", {show_alert: true}));
bot.action('TODO_LIST', (ctx) => ctx.answerCbQuery("Saat ini belum ada tugas yang tersimpan.", {show_alert: true}));

bot.action('MENU_WELLBEING', (ctx) => {
    const msg = `*🧘‍♂️ Modul Kesehatan Mental & Stres*\nSaya akan memantau kondisi Anda secara rutin.`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📉 Input Mood Sekarang', 'MOOD_INPUT'), Markup.button.callback('📊 Laporan Stres Mingguan', 'MOOD_REPORT')],
        [Markup.button.callback('🔙 Kembali ke Menu Utama', 'BACK_MAIN')]
    ]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});
bot.action('MOOD_INPUT', (ctx) => ctx.answerCbQuery("Reminder Mood otomatis aktif jam 20:00.", {show_alert: true}));
bot.action('MOOD_REPORT', (ctx) => ctx.answerCbQuery("Belum ada data mood untuk dianalisa minggu ini.", {show_alert: true}));

bot.action('MENU_AI', (ctx) => {
    const msg = `*🧠 Mode AI JARVIS Aktif*\nAnda tidak perlu menekan tombol tambahan.\n\nCukup ketik pertanyaan di chat ini kapan pun. Otak *Gemini* saya akan langsung merespons.`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Mengerti, Kembali', 'BACK_MAIN')]]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('MENU_SYSTEM', (ctx) => {
    const msg = `*💻 Kontrol PC (SaaS Client Mode)*\nPastikan Anda telah mendownload dan menjalankan \`JARVIS_Client\` di laptop target, lalu gunakan perintah \`/pair PIN\` di Telegram.`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📖 Cara Install & Download', 'SYS_GUIDE')],
        [Markup.button.callback('🔒 Lock Screen', 'SYS_LOCK'), Markup.button.callback('📸 Screenshot Layar', 'SYS_SCREENSHOT')],
        [Markup.button.callback('🕵️ Spy Kamera', 'SYS_WEBCAM'), Markup.button.callback('🔊 Alarm Suara', 'SYS_ALARM')],
        [Markup.button.callback('🔙 Kembali ke Menu Utama', 'BACK_MAIN')]
    ]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('SYS_GUIDE', async (ctx) => {
    const guide = `*🛠️ PANDUAN INSTALASI & DOWNLOAD*\n\n` +
    `Untuk mengontrol laptop Anda dari jarak jauh, ikuti langkah berikut:\n\n` +
    `1. Download file instalasi yang saya lampirkan tepat di bawah pesan ini.\n` +
    `2. Ekstrak file ZIP tersebut di Laptop target Anda.\n` +
    `3. Klik ganda (Double-click) pada aplikasi \`JARVIS_Client.exe\`.\n` +
    `4. Aplikasi akan menyala di belakang layar dan memunculkan **PIN 6-Digit**.\n` +
    `5. Ketik perintah \`/pair <PIN>\` di chat ini (Contoh: \`/pair 123456\`).\n\n` +
    `Selesai! Laptop Anda akan otomatis terikat permanen secara aman tanpa perlu instalasi rumit.`;
    
    await ctx.answerCbQuery("Mempersiapkan file .exe installer...", {show_alert: false});
    await ctx.reply(guide, { parse_mode: 'Markdown' });
    
    // Kirim file .zip yang berisi .exe
    if (fs.existsSync('./JARVIS_Client_EXE.zip')) {
        await ctx.replyWithDocument({ source: './JARVIS_Client_EXE.zip', filename: 'JARVIS_Client_Installer.zip' }, { caption: "Aplikasi JARVIS Client (Tinggal Klik)" });
    } else {
        ctx.reply("❌ File EXE sedang dikompilasi, harap tunggu beberapa saat lalu coba lagi.");
    }
});

const askDeviceTarget = async (ctx, command, title) => {
    const chatId = ctx.chat.id.toString();
    const devices = connectedLaptops[chatId] || {};
    const deviceIds = Object.keys(devices);
    
    if (deviceIds.length === 0) {
        return ctx.reply("❌ Tidak ada laptop yang terhubung. Silakan install JARVIS Client lalu ketik /pair.");
    }

    const buttons = [];
    deviceIds.forEach(id => {
        buttons.push([Markup.button.callback(`💻 Eksekusi di ${id}`, `EXEC_${command}_${id}`)]);
    });
    
    if (deviceIds.length > 1) {
        buttons.push([Markup.button.callback('🌐 Eksekusi di SEMUA Laptop (Bulk)', `EXEC_${command}_ALL`)]);
    }
    
    buttons.push([Markup.button.callback('🔙 Batal', 'MENU_SYSTEM')]);

    try { await ctx.answerCbQuery(); } catch(e) {}
    ctx.editMessageText(`*Pilih Target untuk [${title}]*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

bot.action('SYS_LOCK', (ctx) => askDeviceTarget(ctx, 'LOCK', "🔒 Lock Screen"));
bot.action('SYS_WEBCAM', (ctx) => askDeviceTarget(ctx, 'WEBCAM', "🕵️ Spy Kamera"));
bot.action('SYS_ALARM', (ctx) => askDeviceTarget(ctx, 'ALARM', "🔊 Alarm Suara"));
bot.action('SYS_SCREENSHOT', (ctx) => askDeviceTarget(ctx, 'SCREENSHOT', "📸 Screenshot Layar"));

bot.action(/EXEC_(.+?)_(.+)/, async (ctx) => {
    const command = ctx.match[1];
    const target = ctx.match[2]; // 'ALL' or deviceId
    const chatId = ctx.chat.id.toString();
    const devices = connectedLaptops[chatId] || {};

    try { await ctx.answerCbQuery(); } catch(e) {}

    if (target === 'ALL') {
        let count = 0;
        Object.values(devices).forEach(ws => {
            ws.send(JSON.stringify({ command: command }));
            count++;
        });
        ctx.reply(`✅ Perintah massal [${command}] sukses dikirim ke ${count} perangkat sekaligus!`);
    } else {
        const ws = devices[target];
        if (ws) {
            ws.send(JSON.stringify({ command: command }));
            ctx.reply(`✅ Perintah [${command}] sukses dieksekusi di perangkat ${target}!`);
        } else {
            ctx.reply(`❌ Perangkat ${target} sedang offline.`);
        }
    }
});
bot.action('BACK_MAIN', (ctx) => { ctx.deleteMessage(); sendMainMenu(ctx); });

bot.catch((err, ctx) => {
    console.error(`[Telegraf Error]`, err);
});

bot.launch().then(() => console.log('🤖 JARVIS Cloud Server Berjalan di Port 8080!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
