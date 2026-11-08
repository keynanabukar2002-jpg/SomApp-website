const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'somapp-61ebd';
const EXCHANGE_RATE_SOS_PER_POL = 3000;

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
            balance: parseFloat(data.fields.balance?.doubleValue || data.fields.balance?.integerValue || 0)
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
                balance: { doubleValue: userData.balance },
                createdAt: { timestampValue: new Date().toISOString() }
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
        let balancePOL = 0;

        if (!existingUser || !existingUser.polygonAddress) {
            const newWallet = ethers.Wallet.createRandom();
            internalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            polygonAddress = newWallet.address;
            userPrivateKey = newWallet.privateKey;
            balancePOL = 0;

            await saveFirestoreUser(uid, {
                email: email || `${uid}@knn-micropay.com`,
                displayName: displayName,
                internalUserId: internalUserId,
                polygonAddress: polygonAddress,
                privateKey: userPrivateKey,
                balance: balancePOL
            });
        } else {
            polygonAddress = existingUser.polygonAddress;
            internalUserId = existingUser.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            userPrivateKey = existingUser.privateKey;
            
            // Halkan: Si uu si toos ah uga soo akhrisanayo Balance-ka dhabta ah ee Blockchain-ka (Polygon RPC)
            try {
                const blockchainBalanceWei = await provider.getBalance(polygonAddress);
                balancePOL = parseFloat(ethers.formatEther(blockchainBalanceWei));
                
                // Haddii uu blockchain-ka balance ka jiro, sidoo kale database-ka ayaan cusboonaysiinaynaa
                existingUser.balance = balancePOL;
                await saveFirestoreUser(uid, existingUser);
            } catch (rpcErr) {
                console.error("RPC Balance Fetch Error, fallback to DB:", rpcErr);
                balancePOL = existingUser.balance;
            }
        }

        return res.json({
            success: true,
            userId: internalUserId,
            polygonAddress: polygonAddress,
            privateKey: userPrivateKey,
            balance: balancePOL.toFixed(4)
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API-ga Swap-ka Gudaha
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

        // Si loo hubiyo inuu balance-ka dhabta ah haysto kahor swap-ka
        try {
            const blockchainBalanceWei = await provider.getBalance(userData.polygonAddress);
            userData.balance = parseFloat(ethers.formatEther(blockchainBalanceWei));
        } catch (e) {}

        let currentBalance = userData.balance;

        if (swapType === 'SOS_TO_POL') {
            const polGained = numericAmount / EXCHANGE_RATE_SOS_PER_POL;
            currentBalance += polGained;
        } else if (swapType === 'POL_TO_SOS') {
            if (currentBalance < numericAmount) {
                return res.status(400).json({ success: false, error: "Polygon balance-kaaga ku filma ma ahan!" });
            }
            currentBalance -= numericAmount;
        } else {
            return res.status(400).json({ success: false, error: "Nooca Swap-ka lama aqoonsan." });
        }

        userData.balance = currentBalance;
        await saveFirestoreUser(uid, userData);

        return res.json({
            success: true,
            message: "Swap-kii si guul leh bay u dhacday!",
            newBalance: currentBalance.toFixed(4)
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const userData = await getFirestoreUser(uid);
        if (!userData || !userData.privateKey) {
            return res.status(404).json({ success: false, error: "Private key lama helin." });
        }

        const wallet = new ethers.Wallet(userData.privateKey, provider);
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(amount.toString())
        });

        return res.json({ success: true, message: "Lacagtii waa la diray!", txHash: tx.hash });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
