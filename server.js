const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '500mb' })); // Kordhinta xadka si uu u qaado fiidiyowyo waaweyn
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(cors());

const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'somapp-61ebd';

// Meel ku meel gaar ah oo server-ka ugu keydsan fiidiyowyada (Memory-based store)
let uploadedVideosStore = [];

async function getFirestoreUser(uid) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.fields) return null;
        
        return {
            email: data.fields.email?.stringValue || '',
            displayName: data.fields.displayName?.stringValue || '',
            internalUserId: data.fields.internalUserId?.stringValue || '',
            polygonAddress: data.fields.polygonAddress?.stringValue || '',
            privateKey: data.fields.privateKey?.stringValue || '',
            totalDeposited: parseFloat(data.fields.totalDeposited?.doubleValue || data.fields.totalDeposited?.integerValue || 100.0),
            withdrawnTotal: parseFloat(data.fields.withdrawnTotal?.doubleValue || data.fields.withdrawnTotal?.integerValue || 0.0),
            lastWithdrawDate: data.fields.lastWithdrawDate?.stringValue || ''
        };
    } catch (err) {
        console.error("Firestore Get Error:", err.message);
        return null;
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
                totalDeposited: { doubleValue: userData.totalDeposited },
                withdrawnTotal: { doubleValue: userData.withdrawnTotal },
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

// Auth & Wallet Setup
app.post('/api/auth-user', async (req, res) => {
    try {
        const email = req.body.email || "";
        const uid = req.body.uid || req.body.userId || "";
        const displayName = req.body.displayName || "User";

        if (!uid) {
            return res.status(400).json({ success: false, error: "UID waa maqan yahay." });
        }

        let existingUser = await getFirestoreUser(uid);
        let polygonAddress = "";
        let internalUserId = "";
        let userPrivateKey = "";
        let totalDeposited = 100.0;
        let withdrawnTotal = 0.0;

        if (!existingUser || !existingUser.polygonAddress) {
            const newWallet = ethers.Wallet.createRandom();
            internalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            polygonAddress = newWallet.address;
            userPrivateKey = newWallet.privateKey;

            await saveFirestoreUser(uid, {
                email: email || `${uid}@knn-micropay.com`,
                displayName: displayName,
                internalUserId: internalUserId,
                polygonAddress: polygonAddress,
                privateKey: userPrivateKey,
                totalDeposited: 100.0,
                withdrawnTotal: 0.0,
                lastWithdrawDate: ""
            });
        } else {
            polygonAddress = existingUser.polygonAddress;
            internalUserId = existingUser.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            userPrivateKey = existingUser.privateKey;
            totalDeposited = existingUser.totalDeposited;
            withdrawnTotal = existingUser.withdrawnTotal;
        }

        let currentRemaining = totalDeposited - withdrawnTotal;
        let dailyLimit = parseFloat((totalDeposited / 300).toFixed(4));

        return res.json({
            success: true,
            userId: internalUserId,
            polygonAddress: polygonAddress,
            privateKey: userPrivateKey,
            balance: currentRemaining.toFixed(2),
            dailyLimit: dailyLimit
        });

    } catch (err) {
        console.error("Auth Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Server: " + err.message });
    }
});

// Withdraw API
app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress } = req.body;

        if (!uid || !recipientAddress) {
            return res.status(400).json({ success: false, error: "Fadlan buuxi xogta saxda ah." });
        }

        let userData = await getFirestoreUser(uid);
        if (!userData || !userData.privateKey) {
            return res.status(404).json({ success: false, error: "User-ka lama helin." });
        }

        let currentRemaining = userData.totalDeposited - userData.withdrawnTotal;
        let dailyLimit = parseFloat((userData.totalDeposited / 300).toFixed(4));

        if (currentRemaining <= 0) {
            return res.status(400).json({ success: false, error: "Harraagaaga lacagtu waa ay dhammaatay!" });
        }

        const todayStr = new Date().toISOString().split('T')[0];
        if (userData.lastWithdrawDate === todayStr) {
            return res.status(400).json({ success: false, error: "Horay ayaad u qaadatay saamigaaga maanta! Soo laabo berrito." });
        }

        let withdrawAmount = Math.min(dailyLimit, currentRemaining);

        const adminWallet = new ethers.Wallet(userData.privateKey, provider);
        const tx = await adminWallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(withdrawAmount.toString())
        });

        userData.withdrawnTotal += withdrawAmount;
        userData.lastWithdrawDate = todayStr;
        await saveFirestoreUser(uid, userData);

        let newRemaining = (userData.totalDeposited - userData.withdrawnTotal).toFixed(2);

        return res.json({
            success: true,
            message: `Guul! Waxaad la baxaysey saamigii maanta oo ah ${withdrawAmount.toFixed(2)} POL. Harraagaagu wuxuu noqday ${newRemaining} POL.`,
            txHash: tx.hash,
            newBalance: newRemaining
        });

    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Blockchain: " + err.message });
    }
});

// API: Soo gelinta Video-ga (Server Storage)
app.post('/api/upload-video', async (req, res) => {
    try {
        const { id, uid, username, title, avatar, type, url, timestamp } = req.body;
        if (!uid || !url) {
            return res.status(400).json({ success: false, error: "Xogta video-ga waa maqan tahay." });
        }
        const newVideo = { id, uid, username, title, avatar, type, url, timestamp };
        uploadedVideosStore.unshift(newVideo);
        return res.json({ success: true, message: "Video-ga waa la keydiyay." });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API: Soo qaadashada dhammaan Video-yada
app.get('/api/get-videos', async (req, res) => {
    try {
        return res.json({ success: true, videos: uploadedVideosStore });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API: Tirtirida Video-ga
app.post('/api/delete-video', async (req, res) => {
    try {
        const { videoId, uid } = req.body;
        uploadedVideosStore = uploadedVideosStore.filter(v => v.id !== videoId);
        return res.json({ success: true, message: "Video-ga waa la tirtiray." });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
