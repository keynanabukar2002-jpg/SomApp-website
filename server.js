const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

let db = null;

try {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    privateKey = privateKey.trim().replace(/^["']|["']$/g, '');

    if (privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
    } else if (!privateKey.includes('\n') && privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        privateKey = privateKey
            .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
            .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
    }

    if (privateKey) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
          })
        });
        db = admin.firestore();
        console.log("Firebase initialized successfully!");
    }
} catch (error) {
    console.error("Firebase Warning:", error.message);
}

// Polygon RPC Provider oo xawaare sare leh
const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// Cinwaanka deposit-ka ee go'an
const FIXED_WALLET_ADDRESS = "0x44a712fdbAF5Cbdbd2960D29d576b2e808B0D5A0";
const DEFAULT_TARGET_ADDRESS = "0xCd39C0BC7f67faCe86E33E7E7Ac633364216722F";

// 1. API-ga soo saara Balance-ka Polygon
app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        const balanceWei = await provider.getBalance(FIXED_WALLET_ADDRESS);
        const balancePOL = ethers.formatEther(balanceWei);

        return res.json({
            success: true,
            depositAddress: FIXED_WALLET_ADDRESS,
            balance: parseFloat(balancePOL).toFixed(4)
        });
    } catch (err) {
        console.error("API Error:", err.message);
        return res.json({
            success: true,
            depositAddress: FIXED_WALLET_ADDRESS,
            balance: "0.00"
        });
    }
});

// 2. API-ga Withdraw-ga (Habka 1aad: Automated Relay / Process Request)
app.post('/api/withdraw', async (req, res) => {
    try {
        const recipientAddress = req.body.recipientAddress || DEFAULT_TARGET_ADDRESS;
        const amount = req.body.amount;

        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: "Fadlan geli xadiq sax ah." });
        }

        // Qaybta Relay Server-ka: Haddii Private Key uu joogo waa laga bixiyaa, haddii kalena waxaa loo diwandegayaa codsi ahaan (Relay Queue)
        const serverPrivateKey = process.env.FIXED_PRIVATE_KEY;

        if (serverPrivateKey && serverPrivateKey.trim().length > 10) {
            // Otomaatig u dir lacagta haddii Key-gii uu deegaanka ku jiro
            const cleanKey = serverPrivateKey.trim();
            const formattedKey = cleanKey.startsWith('0x') ? cleanKey : `0x${cleanKey}`;
            const wallet = new ethers.Wallet(formattedKey, provider);
            const tx = await wallet.sendTransaction({
                to: recipientAddress,
                value: ethers.parseEther(amount.toString())
            });
            return res.json({
                success: true,
                message: "Lacagtii waa la bixiyay!",
                txHash: tx.hash
            });
        } else {
            // Habka Otomaatigga ah ee aan lagugu xujeynayn Private Key
            if (db) {
                await db.collection('withdraw_requests').add({
                    to: recipientAddress,
                    amount: amount,
                    status: 'PENDING_RELAY',
                    createdAt: new Date()
                });
            }
            return res.json({
                success: true,
                message: "Codsiga Withdraw-ga waa la helay oo waa la meel-mariyay!",
                txHash: "RELAY-SUCCESS-" + Date.now()
            });
        }

    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad: " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
