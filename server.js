const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const path = require('path');
const cors = require('cors'); // Wajib untuk komunikasi Vercel <-> Render

// Buat Express app dan HTTP server
const app = express();

// --- PENGATURAN KONEKSI DAN CORS ---
// Wajib: Mengizinkan frontend Anda (Vercel) untuk terhubung
app.use(cors({
    origin: '*', // Ganti dengan domain Vercel Anda yang sebenarnya untuk keamanan
    methods: ['GET', 'POST']
}));

// Setup untuk melayani file statis (jika diperlukan, tetapi klien harus memutar suara)
app.use('/public', express.static(path.join(__dirname, 'public')));


// --- DATA SESI SERVER ---
let userLikes = {};
let userGifts = {};
let userShares = {};
let userProfiles = {};

// Array gambar yang akan ditampilkan (Server hanya mengirimkan path, klien yang memuatnya)
const profilePictures = [
    'public/images/image1.jpg',
    'public/images/image2.jpg',
    'public/images/image3.jpg',
];

// Variabel Kontrol
let isPlaying = false;
let currentSoundTimeout = null;
let tiktokLiveConnection;
let currentWebSocket = null; // Menyimpan referensi WebSocket klien aktif (Hanya satu klien diharapkan)

// --- MAPPING SUARA (Logika Anda, Diperluas hingga 50) ---
const soundMapping = {};

// 1. Tambahkan pemetaan angka 1 hingga 50 secara otomatis
for (let i = 1; i <= 50; i++) {
    soundMapping[i.toString()] = `sounds/${i}.mp3`;
}

// 2. Tambahkan pemetaan khusus (Custom Mappings)
Object.assign(soundMapping, {
    'm': 'sounds/1.mp3', // Contoh pemetaan khusus
    'assalamualaikum': 'sounds/salam.mp3',
    'assalamu\'alaikum': 'sounds/salam.mp3',
    'assalamu alaikum': 'sounds/salam.mp3',
    'taptap yuk': 'sounds/kentut.mp3',
    'halo': 'sounds/hallo.mp3',
    // Anda mungkin perlu menambahkan pemetaan untuk suara yang dipicu oleh Gift/Like besar,
    // misalnya untuk 'sounds/winner.mp3' dan 'sounds/like_big.mp3',
    // meskipun ini juga dipicu langsung di fungsi handleGift/handleLike.
});


// --- FUNGSI UTAMA PENANGANAN INTERAKSI ---

function sendToClient(data) {
    if (currentWebSocket && currentWebSocket.readyState === WebSocket.OPEN) {
        currentWebSocket.send(JSON.stringify(data));
    }
}

function updateUserLikes(username, likeCount) {
    userLikes[username] = (userLikes[username] || 0) + likeCount;

    // Tentukan gambar yang akan ditampilkan berdasarkan jumlah like
    let pictureIndex = Math.min(userLikes[username] - 1, profilePictures.length - 1);
    const profilePictureUrl = profilePictures[pictureIndex];

    // Kirimkan perintah floating photo
    sendToClient({
        type: 'floating-photo',
        profilePictureUrl: profilePictureUrl,
        userName: username
    });

    // Kirimkan update data statistik (jika ada tampilan statistik di klien)
    sendToClient({
        type: 'updateStats',
        username: username,
        likes: userLikes[username],
        gifts: userGifts[username] || 0,
        shares: userShares[username] || 0
    });
}

function playSound(soundPath) {
    // Implementasi untuk mencegah tumpang tindih suara di klien
    if (isPlaying) {
        if (currentSoundTimeout) {
            clearTimeout(currentSoundTimeout);
        }
    }

    sendToClient({ type: 'play-sound', sound: soundPath });
    isPlaying = true;

    // Atur timeout untuk menandakan suara selesai (Simulasi 5 detik)
    currentSoundTimeout = setTimeout(() => {
        isPlaying = false;
        sendToClient({ type: 'stop-sound' });
    }, 5000); 
}

function stopPlayingSound() {
    if (isPlaying) {
        clearTimeout(currentSoundTimeout);
        isPlaying = false;
        currentSoundTimeout = null;
        sendToClient({ type: 'stop-sound' });
        console.log('Sound playback stopped by command.');
    }
}

function displayFloatingPhoto(profilePictureUrl, userName) {
    sendToClient({
        type: 'floating-photo',
        profilePictureUrl: profilePictureUrl,
        userName: userName
    });
}

function showBigPhoto(profilePictureUrl, userName) {
    sendToClient({
        type: 'big-photo',
        profilePictureUrl: profilePictureUrl,
        userName: userName
    });
}

// --- PENANGANAN TIKTOK LIVE CONNECTOR ---

function handleMemberJoin(data) {
    console.log(`${data.uniqueId} joined the stream!`);
    userProfiles[data.uniqueId] = data.profilePictureUrl;
    displayFloatingPhoto(data.profilePictureUrl, data.uniqueId);
    playSound('sounds/hallo.mp3');
}

function handleGift(data) {
    const username = data.uniqueId;
    userProfiles[username] = data.profilePictureUrl; // Update PP
    
    // Logika penanganan gift Anda:
    if (data.giftType === 1 && !data.repeatEnd) {
        console.log(`${username} is sending gift ${data.giftName} x${data.repeatCount}`);
    } else {
        // Streak berakhir atau non-streakable gift
        const giftValue = data.repeatCount * data.gift.diamondCount;
        userGifts[username] = (userGifts[username] || 0) + giftValue;

        console.log(`${username} has sent gift ${data.giftName} x${data.repeatCount} (Value: ${giftValue})`);

        showBigPhoto(data.profilePictureUrl, username);
        playSound('sounds/winner.mp3'); 
    }
}

function handleLike(data) {
    console.log(`${data.uniqueId} sent ${data.likeCount} likes`);
    updateUserLikes(data.uniqueId, data.likeCount);

    // Kirim floating photo berulang sesuai jumlah like
    for (let i = 0; i < data.likeCount; i++) {
        setTimeout(() => {
            displayFloatingPhoto(data.profilePictureUrl, data.uniqueId);
        }, i * 500); // Mengurangi delay agar tidak terlalu lama
    }
    
    if (data.likeCount > 10) { 
        playSound('sounds/like_big.mp3'); 
    }
}

function handleShare(data) {
    userShares[data.uniqueId] = (userShares[data.uniqueId] || 0) + 1;
    console.log(`${data.uniqueId} shared the stream!`);
    displayFloatingPhoto(data.profilePictureUrl, data.uniqueId);
    playSound('sounds/kentut.mp3');
}

function handleEnvelope(data) {
    console.log('Envelope received:', data);
    playSound('sounds/anjay.mp3');
    // Kirim notifikasi event envelope ke klien jika diperlukan
    sendToClient({ type: 'envelope-event', data: data });
}

function handleChat(data) {
    const comment = data.comment.trim().toLowerCase();
    console.log(`${data.uniqueId} writes: ${data.comment}`);

    // Kirim data chat ke klien
    sendToClient({
        type: 'chat',
        userName: data.uniqueId,
        comment: data.comment
    });

    // Cek apakah komentar sesuai dengan soundMapping
    const soundFile = soundMapping[comment];
    if (soundFile) {
        playSound(soundFile);
    }

    // Cek apakah komentar adalah "ganti"
    if (comment === 'ganti') {
        stopPlayingSound();
    }
}

// --- INISIALISASI SERVER HTTP/WEBSOCKET ---

const server = http.createServer(app);
// Wajib: Menetapkan path '/ws' untuk kompatibilitas Render
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
    currentWebSocket = ws; // Set klien aktif
    console.log('WebSocket connection established.');

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'connect') {
            const username = data.username;
            console.log('Connecting to TikTok Live with username:', username);

            if (tiktokLiveConnection) {
                tiktokLiveConnection.disconnect();
            }

            try {
                tiktokLiveConnection = new WebcastPushConnection(username);
                await tiktokLiveConnection.connect();

                sendToClient({ type: 'status', message: `Successfully requested connection to @${username}` });

                // --- DAFTAR SEMUA LISTENERS TIKTOK LIVE CONNECTOR ---
                tiktokLiveConnection.on('connected', (state) => {
                    console.log('Hurray! Connected!', state);
                    sendToClient({ type: 'status', message: 'Connected to Live Stream!' });
                });

                tiktokLiveConnection.on('disconnected', () => {
                    console.log('Disconnected :(');
                    sendToClient({ type: 'status', message: 'Disconnected from Live Stream.' });
                });

                tiktokLiveConnection.on('streamEnd', (actionId) => {
                    console.log('Stream ended with actionId:', actionId);
                    sendToClient({ type: 'status', message: 'Stream ended.' });
                });

                // Menggunakan fungsi penanganan tanpa parameter 'ws' karena kita menggunakan 'sendToClient'
                tiktokLiveConnection.on('member', handleMemberJoin);
                tiktokLiveConnection.on('gift', handleGift);
                tiktokLiveConnection.on('like', handleLike);
                tiktokLiveConnection.on('share', handleShare);
                tiktokLiveConnection.on('envelope', handleEnvelope);
                tiktokLiveConnection.on('chat', handleChat);

                tiktokLiveConnection.on('roomUser', (data) => {
                    console.log(`Viewer Count: ${data}`);
                    sendToClient({ type: 'roomUser', viewerCount: data });
                });

            } catch(e) {
                console.error('Error connecting to TikTok:', e.message);
                sendToClient({ type: 'status', message: `Failed to connect: ${e.message}` });
            }
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed.');
        if (currentWebSocket === ws) {
            currentWebSocket = null;
        }
    });
});

// --- RUTE EXPRESS (Sederhana) ---
app.get('/', (req, res) => {
    res.send('BulTok Backend Server (Render) is running.');
});


// --- PELUNCURAN SERVER ---
// Menggunakan process.env.PORT yang akan disediakan oleh Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (Render Deployment Ready)`);
});
