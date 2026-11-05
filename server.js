const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Clean and format the Private Key so it never causes a decoder error
let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
privateKey = privateKey.trim().replace(/^["']|["']$/g, '');

// Check and fix newlines
if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
} else if (!privateKey.includes('\n') && privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    // If Railway stripped the newlines, rebuild them
    privateKey = privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
        .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
}

try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      })
    });
    console.log("Firebase initialized successfully!");
} catch (error) {
    console.error("Firebase Initialization Error:", error.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// Polygon RPC Provider
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: "Email is required" });

        if (!db) {
            const newWallet = ethers.Wallet.createRandom();
            return res.json({
                success: true,
                depositAddress: newWallet.address,
                balance: 0.0
            });
        }

        const userRef = db.collection('users').doc(email);
        const doc = await userRef.get();

        if (doc.exists) {
            const data = doc.data();
            return res.json({
                success: true,
                depositAddress: data.depositAddress,
                balance: data.balance || 0.0
            });
        } else {
            const newWallet = ethers.Wallet.createRandom();
            const userData = {
                email: email,
                depositAddress: newWallet.address,
                privateKey: newWallet.privateKey,
                balance: 0.0,
                createdAt: new Date()
            };
            await userRef.set(userData);
            return res.json({
                success: true,
                depositAddress: newWallet.address,
                balance: 0.0
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
