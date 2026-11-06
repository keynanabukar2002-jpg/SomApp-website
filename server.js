const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'somapp-61ebd';

// Master Wallet-ka Server-ka ee bixinaya ama helaya POL
const MASTER_PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const MASTER_WALLET_ADDRESS = process.env.MASTER_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";
const POL_USD_PRICE = 0.5; // 1 POL = $0.5 USD

// Firestore REST Helpers
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
            privateKey: data.fields.privateKey?.stringValue || ''
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

async function logTransaction(uid, txData) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/transactions`;
        const body = {
            fields: {
                uid: { stringValue: uid },
                type: { stringValue: txData.type }, // 'EVC_DEPOSIT', 'EVC_WITHDRAW', 'POL_WITHDRAW'
                amount: { stringValue: txData.amount },
                details: { stringValue: txData.details },
                txHash: { stringValue: txData.txHash || '' },
                timestamp: { timestampValue: new Date().toISOString() }
            }
        };
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (err) {
        console.error("Tx Log Error:", err.message);
    }
}

// 1. Auth & Wallet API
app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) return res.status(400).json({ success: false, error: "UID waa maqan yahay." });

        let existingUser = await getFirestoreUser(uid);
        let polygonAddress = "", internalUserId = "", userPrivateKey = "";

        if (!existingUser || !existingUser.polygonAddress) {
            const newWallet = ethers.Wallet.createRandom();
            internalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            polygonAddress = newWallet.address;
            userPrivateKey = newWallet.privateKey;

            await saveFirestoreUser(uid, {
                email: email || `${uid}@knn-micropay.com`,
                displayName: displayName || "User",
                internalUserId,
                polygonAddress,
                privateKey: userPrivateKey
            });
        } else {
            polygonAddress = existingUser.polygonAddress;
            internalUserId = existingUser.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            userPrivateKey = existingUser.privateKey;
        }

        let balancePOL = "0.0000";
        try {
            const balanceWei = await provider.getBalance(polygonAddress);
            balancePOL = ethers.formatEther(balanceWei);
        } catch (rpcErr) {
            console.warn("RPC Warning:", rpcErr.message);
        }

        return res.json({
            success: true,
            userId: internalUserId,
            polygonAddress,
            privateKey: userPrivateKey,
            balance: parseFloat(balancePOL).toFixed(4)
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 2. EVC Plus Deposit Gateway (EVC -> POL)
app.post('/api/evc-deposit', async (req, res) => {
    try {
        const { uid, phoneNumber, amountUsd } = req.body;
        if (!uid || !phoneNumber || !amountUsd || parseFloat(amountUsd) <= 0) {
            return res.status(400).json({ success: false, error: "Buuxi xogta EVC Plus." });
        }

        const userData = await getFirestoreUser(uid);
        if (!userData || !userData.polygonAddress) {
            return res.status(404).json({ success: false, error: "User-ka lama helin." });
        }

        const polAmount = parseFloat(amountUsd) / POL_USD_PRICE;
        const masterWallet = new ethers.Wallet(MASTER_PRIVATE_KEY, provider);

        const tx = await masterWallet.sendTransaction({
            to: userData.polygonAddress,
            value: ethers.parseEther(polAmount.toString())
        });

        await logTransaction(uid, {
            type: 'EVC_DEPOSIT',
            amount: `${amountUsd} USD (${polAmount.toFixed(4)} POL)`,
            details: `Kagada EVC: ${phoneNumber}`,
            txHash: tx.hash
        });

        return res.json({
            success: true,
            message: `$${amountUsd} oo EVC Plus ah waxaa loo beddelay ${polAmount.toFixed(4)} POL.`,
            txHash: tx.hash
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Cilad Gateway: " + err.message });
    }
});

// 3. EVC Plus Withdraw Gateway (POL -> EVC)
app.post('/api/polygon-to-evc', async (req, res) => {
    try {
        const { uid, phoneNumber, amountPol } = req.body;
        if (!uid || !phoneNumber || !amountPol || parseFloat(amountPol) <= 0) {
            return res.status(400).json({ success: false, error: "Buuxi xogta saxda ah." });
        }

        const userData = await getFirestoreUser(uid);
        if (!userData || !userData.privateKey) {
            return res.status(404).json({ success: false, error: "User-ka lama helin." });
        }

        const userWallet = new ethers.Wallet(userData.privateKey, provider);
        const tx = await userWallet.sendTransaction({
            to: MASTER_WALLET_ADDRESS,
            value: ethers.parseEther(amountPol.toString())
        });

        const usdEquivalent = (parseFloat(amountPol) * POL_USD_PRICE).toFixed(2);

        await logTransaction(uid, {
            type: 'EVC_WITHDRAW',
            amount: `${amountPol} POL ($${usdEquivalent} USD)`,
            details: `Loo diray EVC: ${phoneNumber}`,
            txHash: tx.hash
        });

        return res.json({
            success: true,
            message: `${amountPol} POL waxaa loo beddelay $${usdEquivalent} USD oo loo diray ${phoneNumber}.`,
            txHash: tx.hash
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Cilad Blockchain: " + err.message });
    }
});

// 4. Polygon Standard Withdraw
app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const userData = await getFirestoreUser(uid);

        const wallet = new ethers.Wallet(userData.privateKey, provider);
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(amount.toString())
        });

        await logTransaction(uid, {
            type: 'POL_WITHDRAW',
            amount: `${amount} POL`,
            details: `Qaataha: ${recipientAddress}`,
            txHash: tx.hash
        });

        return res.json({ success: true, message: "Lacagtii waa la diray!", txHash: tx.hash });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
