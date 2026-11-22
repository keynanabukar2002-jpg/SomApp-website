const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ethers } = require('ethers');

let admin = null;
let firestoreDb = null;

try {
    admin = require('firebase-admin');
} catch (_) {
    admin = null;
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'users-db.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos-db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: 100 * 1024 * 1024 }
});

const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

const MIN_DEPOSIT_POL = 0.00001;
const MIN_WITHDRAW_POL = 0.00000001;
// Saamiga maalinlaha ah ee mining-ka (tusaale 10% maalin kasta oo ka mid ah deposit-ka on-chain)
const DAILY_MINING_RATE = 0.10;
const FIRESTORE_USERS_COLLECTION = 'knn_users';

function initFirestore() {
    if (!admin) return null;
    if (firestoreDb) return firestoreDb;

    try {
        const rawSvc = process.env.FIREBASE_SERVICE_ACCOUNT || '';
        if (!rawSvc.trim()) return null;

        const serviceAccount = JSON.parse(rawSvc);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                projectId: serviceAccount.project_id || 'somapp-61ebd'
            });
        }
        firestoreDb = admin.firestore();
        console.log('Firebase Firestore connected:', serviceAccount.project_id || 'somapp-61ebd');
        return firestoreDb;
    } catch (err) {
        console.error('Firestore init error:', err.message);
        return null;
    }
}

initFirestore();

function isValidPrivateKey(pk) {
    return typeof pk === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pk.trim());
}

function isWalletPairValid(address, privateKey) {
    if (!ethers.isAddress(address) || !isValidPrivateKey(privateKey)) {
        return false;
    }
    try {
        const derivedWallet = new ethers.Wallet(privateKey.trim());
        return derivedWallet.address.toLowerCase() === ethers.getAddress(address.trim()).toLowerCase();
    } catch (_) {
        return false;
    }
}

function loadJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error('JSON load error:', filePath, err.message);
        return fallback;
    }
}

function saveJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadLocalUsersDb() {
    return loadJsonFile(DB_FILE, {});
}

function saveLocalUsersDb(data) {
    saveJsonFile(DB_FILE, data);
}

async function loadUsersDb() {
    const localDb = loadLocalUsersDb();
    const db = initFirestore();
    if (!db) return localDb;

    try {
        const snap = await db.collection(FIRESTORE_USERS_COLLECTION).get();
        const merged = { ...localDb };
        snap.forEach(doc => {
            const docData = doc.data();
            if (docData && docData.uid) {
                merged[docData.uid] = {
                    ...(merged[docData.uid] || {}),
                    ...docData
                };
            }
        });
        saveLocalUsersDb(merged);
        return merged;
    } catch (err) {
        console.error('Firestore loadUsersDb error:', err.message);
        return localDb;
    }
}

async function saveSingleUser(userRecord) {
    if (!userRecord || !userRecord.uid) return;
    const localDb = loadLocalUsersDb();
    localDb[userRecord.uid] = userRecord;
    saveLocalUsersDb(localDb);

    const db = initFirestore();
    if (db) {
        try {
            await db.collection(FIRESTORE_USERS_COLLECTION).doc(String(userRecord.uid)).set(userRecord, { merge: true });
        } catch (err) {
            console.error('Firestore saveSingleUser error:', err.message);
        }
    }
}

function loadVideosDb() {
    return loadJsonFile(VIDEOS_FILE, []);
}

function saveVideosDb(data) {
    saveJsonFile(VIDEOS_FILE, data);
}

function generateUniqueAccountId(usersDb) {
    let userId = '';
    let exists = true;
    while (exists) {
        const randomSix = Math.floor(100000 + Math.random() * 900000);
        userId = `KNN-${randomSix}`;
        exists = Object.values(usersDb).some(u => u.userId === userId);
    }
    return userId;
}

async function getOnChainPolBalance(address) {
    try {
        if (!address || !ethers.isAddress(address)) return 0;
        const balWei = await provider.getBalance(address);
        return parseFloat(ethers.formatEther(balWei));
    } catch (err) {
        console.error('On-chain balance error:', err.message);
        return 0;
    }
}

async function syncUserRealMining(uid, usersDb) {
    const userRecord = usersDb[uid];
    if (!userRecord || !ethers.isAddress(userRecord.polygonAddress)) return null;

    const normalizedAddr = ethers.getAddress(userRecord.polygonAddress);
    userRecord.polygonAddress = normalizedAddr;
    userRecord.walletLocked = true;

    const currentOnChainPol = await getOnChainPolBalance(normalizedAddr);
    const prevOnChainPol = parseFloat(userRecord.lastKnownOnChainPol || 0);
    let totalDeposited = parseFloat(userRecord.totalDeposited || 0);
    let miningBalance = parseFloat(userRecord.balance || 0);
    let dailyLimit = parseFloat(userRecord.dailyLimit || 0);
    let miningActive = Boolean(userRecord.miningActive);

    // Haddii hadhaaga on-chain uu kordhay, waxaa ku dhacay deposit dhab ah
    if (currentOnChainPol > prevOnChainPol) {
        const incomingPol = currentOnChainPol - prevOnChainPol;
        if (incomingPol >= MIN_DEPOSIT_POL) {
            totalDeposited += incomingPol;
            const addedDailyCapacity = incomingPol * DAILY_MINING_RATE;
            dailyLimit += addedDailyCapacity;
            miningBalance += addedDailyCapacity;
            miningActive = true;
        }
        userRecord.lastKnownOnChainPol = currentOnChainPol;
    } else if (currentOnChainPol === 0 && prevOnChainPol > 0) {
        userRecord.lastKnownOnChainPol = 0;
    }

    // Haddii mining uu shidan yahay, xisaabi kororka wakhtiga dhabta ah tan iyo markii ugu dambaysay
    const now = Date.now();
    const lastTick = Number(userRecord.lastMiningTick || now);
    if (miningActive && dailyLimit > 0 && now > lastTick) {
        const elapsedSeconds = (now - lastTick) / 1000;
        const perSecRate = dailyLimit / 86400;
        miningBalance += elapsedSeconds * perSecRate;
    }

    userRecord.lastMiningTick = now;
    userRecord.totalDeposited = Number(totalDeposited.toFixed(8));
    userRecord.balance = Number(miningBalance.toFixed(8));
    userRecord.dailyLimit = Number(dailyLimit.toFixed(8));
    userRecord.miningActive = miningActive && (userRecord.balance > 0 || userRecord.dailyLimit > 0);
    userRecord.onChainPol = Number(currentOnChainPol.toFixed(8));

    await saveSingleUser(userRecord);
    return userRecord;
}

setInterval(async () => {
    try {
        const usersDb = await loadUsersDb();
        for (const uid of Object.keys(usersDb)) {
            await syncUserRealMining(uid, usersDb);
        }
    } catch (err) {
        console.error('Background real mining sync error:', err.message);
    }
}, 60000);

app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'KNN MicroPay Backend',
        status: 'running',
        firestoreEnabled: Boolean(initFirestore())
    });
});

app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID waa loo baahan yahay' });
        }

        const usersDb = await loadUsersDb();
        const existing = usersDb[uid];
        const effectiveEmail = (email || existing?.email || '').trim();

        const hasValidWallet =
            existing &&
            existing.userId &&
            isWalletPairValid(existing.polygonAddress, existing.privateKey);

        if (!hasValidWallet) {
            const wallet = ethers.Wallet.createRandom();
            const newUserId = generateUniqueAccountId(usersDb);
            const initialOnChainPol = await getOnChainPolBalance(wallet.address);

            usersDb[uid] = {
                uid,
                email: effectiveEmail,
                displayName: displayName || 'User',
                userId: newUserId,
                polygonAddress: ethers.getAddress(wallet.address),
                privateKey: wallet.privateKey,
                walletLocked: true,
                balance: 0,
                dailyLimit: 0,
                miningActive: false,
                totalDeposited: 0,
                lastKnownOnChainPol: initialOnChainPol,
                lastMiningTick: Date.now(),
                createdAt: Date.now()
            };

            await saveSingleUser(usersDb[uid]);
        } else {
            if (effectiveEmail) usersDb[uid].email = effectiveEmail;
            if (displayName) usersDb[uid].displayName = displayName;
            usersDb[uid].walletLocked = true;
            await saveSingleUser(usersDb[uid]);
        }

        const syncedRecord = await syncUserRealMining(uid, usersDb);

        return res.json({
            success: true,
            userId: syncedRecord.userId,
            polygonAddress: syncedRecord.polygonAddress,
            privateKey: syncedRecord.privateKey,
            balance: Number(syncedRecord.balance || 0).toFixed(8),
            dailyLimit: Number(syncedRecord.dailyLimit || 0).toFixed(8),
            miningActive: Boolean(syncedRecord.miningActive),
            onChainBalance: Number(syncedRecord.onChainPol || 0).toFixed(8)
        });
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ success: false, error: 'Cilad server ayaa dhacday' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const usersDb = await loadUsersDb();
        const userRecord = usersDb[uid];

        if (!userRecord) {
            return res.status(404).json({ success: false, error: 'Xisaabta lama helin' });
        }
        if (!recipientAddress || !ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ success: false, error: 'Cinwaanka recipient-ka waa qalad' });
        }
        if (!isWalletPairValid(userRecord.polygonAddress, userRecord.privateKey)) {
            return res.status(400).json({ success: false, error: 'Private key-ga wallet-ka akoonkan waa qalad' });
        }

        const signer = new ethers.Wallet(userRecord.privateKey.trim(), provider);
        const onChainBalanceWei = await provider.getBalance(signer.address);
        const onChainBalancePol = Number(ethers.formatEther(onChainBalanceWei));

        const requestedPol = amount !== undefined && amount !== null && String(amount).trim() !== ''
            ? parseFloat(amount)
            : onChainBalancePol;

        if (isNaN(requestedPol) || requestedPol < MIN_WITHDRAW_POL) {
            return res.status(400).json({ success: false, error: `Xaddiga ugu yar ee la bixi karo waa ${MIN_WITHDRAW_POL} POL` });
        }

        const amountWei = ethers.parseEther(requestedPol.toFixed(8));
        const feeData = await provider.getFeeData();
        const gasLimit = 21000n;
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei');
        const totalGasCostWei = gasLimit * maxFeePerGas;

        if (onChainBalanceWei < amountWei + totalGasCostWei) {
            return res.status(400).json({
                success: false,
                error: `Hadhaaga on-chain ee wallet-kaaga (${onChainBalancePol.toFixed(8)} POL) kuma filna qaddarka iyo gas-ka`
            });
        }

        const tx = await signer.sendTransaction({
            to: ethers.getAddress(recipientAddress.trim()),
            value: amountWei,
            gasLimit,
            maxFeePerGas
        });

        await tx.wait(1);

        const updatedWei = await provider.getBalance(signer.address);
        const updatedPol = Number(ethers.formatEther(updatedWei));
        userRecord.lastKnownOnChainPol = updatedPol;
        userRecord.onChainPol = updatedPol;
        userRecord.balance = Math.max(0, Number(userRecord.balance || 0) - requestedPol).toFixed(8);
        userRecord.miningActive = parseFloat(userRecord.balance) > 0;
        await saveSingleUser(userRecord);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol.toFixed(8)} POL! Tx: ${tx.hash}`,
            newBalance: Number(userRecord.balance).toFixed(8),
            txHash: tx.hash
        });
    } catch (err) {
        console.error('Withdraw error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Cilad blockchain ayaa dhacday' });
    }
});

app.get('/api/get-videos', (req, res) => {
    const videos = loadVideosDb();
    res.json({ success: true, videos });
});

app.post('/api/upload-video', upload.single('mediaFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Fadlan dooro sawir ama video' });
        }

        const ext = path.extname(req.file.originalname || '') || (req.body.type === 'image' ? '.jpg' : '.mp4');
        const finalFilename = `${req.file.filename}${ext}`;
        const finalPath = path.join(UPLOADS_DIR, finalFilename);
        fs.renameSync(req.file.path, finalPath);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.get('host');
        const fileUrl = `${protocol}://${host}/uploads/${finalFilename}`;

        const videos = loadVideosDb();
        const newVideo = {
            id: req.body.id || `vid_${Date.now()}`,
            uid: req.body.uid || '',
            username: req.body.username || 'User',
            title: req.body.title || 'Video cusub',
            avatar: req.body.avatar || '',
            type: req.body.type || (req.file.mimetype.startsWith('image/') ? 'image' : 'video'),
            url: fileUrl,
            likes: [],
            subscribers: [],
            comments: [],
            reposts: 0,
            timestamp: Number(req.body.timestamp) || Date.now()
        };

        videos.unshift(newVideo);
        saveVideosDb(videos);

        return res.json({ success: true, video: newVideo });
    } catch (err) {
        console.error('Upload error:', err);
        return res.status(500).json({ success: false, error: 'Cilad ayaa dhacday marka faylka la soo gelinayay' });
    }
});

app.post('/api/interact-video', (req, res) => {
    try {
        const { videoId, action, userId, userName, commentText } = req.body;
        const videos = loadVideosDb();
        const vid = videos.find(v => v.id === videoId);

        if (!vid) {
            return res.status(404).json({ success: false, error: 'Video-ga lama helin' });
        }

        vid.likes = Array.isArray(vid.likes) ? vid.likes : [];
        vid.subscribers = Array.isArray(vid.subscribers) ? vid.subscribers : [];
        vid.comments = Array.isArray(vid.comments) ? vid.comments : [];
        vid.reposts = Number(vid.reposts) || 0;

        if (action === 'like') {
            const idx = vid.likes.indexOf(userId);
            if (idx >= 0) vid.likes.splice(idx, 1);
            else if (userId) vid.likes.push(userId);
        } else if (action === 'subscribe') {
            const subName = userName || userId || 'User';
            const idx = vid.subscribers.indexOf(subName);
            if (idx >= 0) vid.subscribers.splice(idx, 1);
            else vid.subscribers.push(subName);
        } else if (action === 'comment') {
            if (commentText) {
                vid.comments.push({
                    user: userName || 'User',
                    text: commentText,
                    timestamp: Date.now()
                });
            }
        } else if (action === 'repost') {
            vid.reposts += 1;
        }

        saveVideosDb(videos);

        return res.json({
            success: true,
            likes: vid.likes,
            subscribers: vid.subscribers,
            comments: vid.comments,
            reposts: vid.reposts
        });
    } catch (err) {
        console.error('Interact video error:', err);
        return res.status(500).json({ success: false, error: 'Cilad ayaa dhacday' });
    }
});

app.post('/api/delete-video', (req, res) => {
    try {
        const { videoId } = req.body;
        const videos = loadVideosDb();
        const target = videos.find(v => v.id === videoId);

        if (target && target.url) {
            const filename = path.basename(target.url);
            const fullPath = path.join(UPLOADS_DIR, filename);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }

        const filtered = videos.filter(v => v.id !== videoId);
        saveVideosDb(filtered);
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete video error:', err);
        return res.status(500).json({ success: false, error: 'Lama tirtiri karo video-ga' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
