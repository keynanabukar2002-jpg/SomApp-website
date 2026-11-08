const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'somapp-61ebd';

// Qiimaha Sarifka ee aad cayimatay: 1000 SOS = 0.4537 POL -> 1 POL = (1000 / 0.4537) SOS
const POL_TO_SOS_RATE = 1000 / 0.4537; // Qiyaastii 2204.09 SOS halkii POL

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
            sosAddress: data.fields.sosAddress?.stringValue || '',
            privateKey: data.fields.privateKey?.stringValue || '',
            polBalance: parseFloat(data.fields.polBalance?.doubleValue || data.fields.polBalance?.integerValue || 0),
            sosBalance: parseFloat(data.fields.sosBalance?.doubleValue || data.fields.sosBalance?.integerValue || 0)
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
                sosAddress: { stringValue: userData.sosAddress || userData.polygonAddress }, // Cinwaanka SOS oo la jaanqaadaya ama gooni ah
                privateKey: { stringValue: userData.privateKey },
                polBalance: { doubleValue: userData.polBalance },
                sosBalance: { doubleValue: userData.sosBalance },
                updatedAt: { timestampValue: new Date().toISOString() }
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

// 1. Auth & User Initialization
app.post('/api/auth-user', async (req, res) => {
    try {
        const email = req.body.email || "";
        const uid = req.body.uid || req.body.userId || "";
        const displayName = req.body.displayName || "User";

        if (!uid) return res.status(400).json({ success: false, error: "UID waa maqan yahay." });

        let existingUser = await getFirestoreUser(uid);
        let polygonAddress = "";
        let internalUserId = "";
        let userPrivateKey = "";
        let polBalance = 0;
        let sosBalance = 0;

        if (!existingUser || !existingUser.polygonAddress) {
            const newWallet = ethers.Wallet.createRandom();
            internalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            polygonAddress = newWallet.address;
            userPrivateKey = newWallet.privateKey;
            polBalance = 0;
            sosBalance = 0; // Bilaabow eber ama intii hore

            await saveFirestoreUser(uid, {
                email: email || `${uid}@knn-micropay.com`,
                displayName: displayName,
                internalUserId: internalUserId,
                polygonAddress: polygonAddress,
                sosAddress: polygonAddress, // Isticmaalka cinwaanka blockchain-ka ee SOS sidoo kale
                privateKey: userPrivateKey,
                polBalance: polBalance,
                sosBalance: sosBalance
            });
        } else {
            polygonAddress = existingUser.polygonAddress;
            internalUserId = existingUser.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            userPrivateKey = existingUser.privateKey;
            polBalance = existingUser.polBalance;
            sosBalance = existingUser.sosBalance;

            // Hubinta balance-ka dhabta ah ee Blockchain-ka ee POL si aanay u lixin
            try {
                const blockchainBalanceWei = await provider.getBalance(polygonAddress);
                const livePol = parseFloat(ethers.formatEther(blockchainBalanceWei));
                if (livePol > polBalance) {
                    polBalance = livePol; // Haddii deposit blockchain ka yimid kor u qaad
                }
            } catch (e) {}

            // Keydi xogta la hubiyay
            existingUser.polBalance = polBalance;
            await saveFirestoreUser(uid, existingUser);
        }

        return res.json({
            success: true,
            userId: internalUserId,
            polygonAddress: polygonAddress,
            sosAddress: polygonAddress,
            privateKey: userPrivateKey,
            polBalance: polBalance.toFixed(4),
            sosBalance: sosBalance.toFixed(2)
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Internal Swap API (SOS <-> POL iyadoo la raacayo sicirka 1000 SOS = 0.4537 POL)
app.post('/api/swap', async (req, res) => {
    try {
        const { uid, swapType, amount } = req.body;
        const numericAmount = parseFloat(amount);

        if (!uid || !numericAmount || numericAmount <= 0) {
            return res.status(400).json({ success: false, error: "Xogta swap-ka ma ahan mid sax ah." });
        }

        let userData = await getFirestoreUser(uid);
        if (!userData) {
            return res.status(404).json({ success: false, error: "User-ka lama helin." });
        }

        let polBal = userData.polBalance;
        let sosBal = userData.sosBalance;

        if (swapType === 'SOS_TO_POL') {
            // Qofku wuxuu bixinayaa Shilin Soomaali (SOS), wuxuu helayaa Polygon (POL)
            // Sicirka: 1000 SOS = 0.4537 POL -> 1 SOS = 0.4537 / 1000 POL
            if (sosBal < numericAmount) {
                return res.status(400).json({ success: false, error: "Shilin Soomaaliga ku filan ma haysatid!" });
            }
            const polGained = numericAmount * (0.4537 / 1000);
            sosBal -= numericAmount;
            polBal += polGained;

        } else if (swapType === 'POL_TO_SOS') {
            // Qofku wuxuu bixinayaa Polygon (POL), wuxuu helayaa Shilin Soomaali (SOS)
            if (polBal < numericAmount) {
                return res.status(400).json({ success: false, error: "Polygon balance-kaaga ku filma ma ahan!" });
            }
            const sosGained = numericAmount * (1000 / 0.4537);
            polBal -= numericAmount;
            sosBal += sosGained;

        } else {
            return res.status(400).json({ success: false, error: "Nooca Swap-ka lama aqoonsan." });
        }

        userData.polBalance = polBal;
        userData.sosBalance = sosBal;
        await saveFirestoreUser(uid, userData);

        return res.json({
            success: true,
            message: "Swap-kii si guul leh bay u dhacday!",
            newPolBalance: polBal.toFixed(4),
            newSosBalance: sosBal.toFixed(2)
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Withdraw POL API
app.post('/api/withdraw-pol', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const userData = await getFirestoreUser(uid);
        if (!userData || !userData.privateKey) {
            return res.status(404).json({ success: false, error: "Private key lama helin." });
        }

        const amt = parseFloat(amount);
        if (userData.polBalance < amt) {
            return res.status(400).json({ success: false, error: "Balance-ka POLagu kuguma filna." });
        }

        const wallet = new ethers.Wallet(userData.privateKey, provider);
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(amt.toString())
        });

        userData.polBalance -= amt;
        await saveFirestoreUser(uid, userData);

        return res.json({ success: true, message: "Lacagtii POL waa la diray!", txHash: tx.hash, newPolBalance: userData.polBalance.toFixed(4) });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Withdraw SOS API (Nidaamka bixinta Shilin Soomaaliga)
app.post('/api/withdraw-sos', async (req, res) => {
    try {
        const { uid, recipientAccount, amount } = req.body;
        const userData = await getFirestoreUser(uid);
        if (!userData) return res.status(404).json({ success: false, error: "User lama helin." });

        const amt = parseFloat(amount);
        if (userData.sosBalance < amt) {
            return res.status(400).json({ success: false, error: "Shilin Soomaaligaagu kuguma filna." });
        }

        userData.sosBalance -= amt;
        await saveFirestoreUser(uid, userData);

        return res.json({ success: true, message: "Codsigii Shilin Soomaaliga waa la diiwaangeliyey!", newSosBalance: userData.sosBalance.toFixed(2) });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
