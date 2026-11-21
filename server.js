const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ethers } = require('ethers');

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

// Akoonka xiran ee la xusay
const LOCKED_OWNER_EMAIL = 'abuukarcumar661@gmail.com';
const LOCKED_OWNER_ACCOUNT_ID = 'KNN-205792';
const LOCKED_OWNER_ADDRESS = ethers.getAddress('0x613b603440CA724C266FC5432E2a20D000F73367');

const DAILY_REWARD_POL = 0.000009;
const MIN_WITHDRAW_POL = 0.00000001;

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

const ENV_TREASURY_KEY = normalizePrivateKey(process.env.MAIN_WALLET_PRIVATE_KEY || '');

function isLockedOwner(email) {
    return String(email || '').trim().toLowerCase() === LOCKED_OWNER_EMAIL.toLowerCase();
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

function loadUsersDb() {
    return loadJsonFile(DB_FILE, {});
}

function saveUsersDb(data) {
    saveJsonFile(DB_FILE, data);
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
        exists = userId === LOCKED_OWNER_ACCOUNT_ID || Object.values(usersDb).some(u => u.userId === userId);
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

app.get('/', (req, res) => {
    res.json({ success: true, service: 'KNN MicroPay Backend', status: 'running' });
});

app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID waa loo baahan yahay' });
        }

        const usersDb = loadUsersDb();
        const existing = usersDb[uid];
        const effectiveEmail = (email || existing?.email || '').trim();

        if (isLockedOwner(effectiveEmail)) {
            const existingKey = normalizePrivateKey(existing?.privateKey || '');
            let chosenKey = '';
            if (isValidPrivateKey(ENV_TREASURY_KEY) && isWalletPairValid(LOCKED_OWNER_ADDRESS, ENV_TREASURY_KEY)) {
                chosenKey = ENV_TREASURY_KEY;
            } else if (isValidPrivateKey(existingKey) && isWalletPairValid(LOCKED_OWNER_ADDRESS, existingKey)) {
                chosenKey = existingKey;
            } else if (isValidPrivateKey(ENV_TREASURY_KEY)) {
                chosenKey = ENV_TREASURY_KEY;
            } else if (isValidPrivateKey(existingKey)) {
                chosenKey = existingKey;
            }

            const onChainPol = await getOnChainPolBalance(LOCKED_OWNER_ADDRESS);
            const savedBal = parseFloat(existing?.balance || 0);
            const finalBalance = Math.max(onChainPol, savedBal);
            const shouldMine = finalBalance > 0 || Boolean(existing?.miningActive);

            usersDb[uid] = {
                uid,
                email: effectiveEmail || LOCKED_OWNER_EMAIL,
                displayName: displayName || existing?.displayName || 'Abuukar Cumar',
                userId: LOCKED_OWNER_ACCOUNT_ID,
                polygonAddress: LOCKED_OWNER_ADDRESS,
                privateKey: chosenKey,
                walletLocked: true,
                balance: finalBalance.toFixed(8),
                dailyLimit: shouldMine ? DAILY_REWARD_POL.toFixed(6) : (existing?.dailyLimit || '0'),
                miningActive: shouldMine,
                createdAt: existing?.createdAt || Date.now()
            };

            saveUsersDb(usersDb);
        } else {
            const hasValidLockedWallet =
                existing &&
                existing.userId &&
                existing.walletLocked === true &&
                isWalletPairValid(existing.polygonAddress, existing.privateKey);

            if (!hasValidLockedWallet) {
                const wallet = ethers.Wallet.createRandom();
                const newUserId = generateUniqueAccountId(usersDb);

                usersDb[uid] = {
                    uid,
                    email: effectiveEmail,
                    displayName: displayName || 'User',
                    userId: newUserId,
                    polygonAddress: ethers.getAddress(wallet.address),
                    privateKey: wallet.privateKey,
                    walletLocked: true,
                    balance: '0',
                    dailyLimit: '0',
                    miningActive: false,
                    createdAt: Date.now()
                };

                saveUsersDb(usersDb);
            } else {
                const onChainPol = await getOnChainPolBalance(existing.polygonAddress);
                const savedBal = parseFloat(existing.balance || 0);
                const finalBalance = Math.max(onChainPol, savedBal);
                const shouldMine = finalBalance > 0 || Boolean(existing.miningActive);

                if (effectiveEmail) usersDb[uid].email = effectiveEmail;
                if (displayName) usersDb[uid].displayName = displayName;
                usersDb[uid].walletLocked = true;
                usersDb[uid].balance = finalBalance.toFixed(8);
                if (shouldMine) {
                    usersDb[uid].miningActive = true;
                    if (parseFloat(usersDb[uid].dailyLimit || 0) <= 0) {
                        usersDb[uid].dailyLimit = DAILY_REWARD_POL.toFixed(6);
                    }
                }
                saveUsersDb(usersDb);
            }
        }

        const userRecord = usersDb[uid];

        return res.json({
            success: true,
            userId: userRecord.userId,
            polygonAddress: userRecord.polygonAddress,
            privateKey: userRecord.privateKey,
            balance: userRecord.balance,
            dailyLimit: userRecord.dailyLimit,
            miningActive: userRecord.miningActive
        });
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ success: false, error: 'Cilad server ayaa dhacday' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const usersDb = loadUsersDb();
        const userRecord = usersDb[uid];

        if (!userRecord) {
            return res.status(404).json({ success: false, error: 'Xisaabta lama helin' });
        }
        if (!recipientAddress || !ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ success: false, error: 'Cinwaanka recipient-ka waa qalad' });
        }

        const keyToUse = isLockedOwner(userRecord.email) && isValidPrivateKey(ENV_TREASURY_KEY)
            ? ENV_TREASURY_KEY
            : (isValidPrivateKey(userRecord.privateKey) ? userRecord.privateKey.trim() : '');

        if (!keyToUse) {
            return res.status(400).json({ success: false, error: 'Private key-ga akoonkan waa qalad ama lama helin' });
        }

        const signer = new ethers.Wallet(keyToUse, provider);
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
        const updatedPol = ethers.formatEther(updatedWei);
        userRecord.balance = updatedPol;
        saveUsersDb(usersDb);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol.toFixed(8)} POL! Tx: ${tx.hash}`,
            newBalance: updatedPol,
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
