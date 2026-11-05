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

// Polygon RPC Provider si loo ogaado lacagta dhabta ah (Live Balance)
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: "Email is required" });

        let walletAddress = "";
        let storedPrivateKey = "";

        if (!db) {
            const newWallet = ethers.Wallet.createRandom();
            walletAddress = newWallet.address;
            storedPrivateKey = newWallet.privateKey;
        } else {
            const userRef = db.collection('users').doc(email);
            const doc = await userRef.get();

            if (doc.exists) {
                const data = doc.data();
                walletAddress = data.depositAddress;
            } else {
                const newWallet = ethers.Wallet.createRandom();
                walletAddress = newWallet.address;
                storedPrivateKey = newWallet.privateKey;
                await userRef.set({
                    email: email,
                    depositAddress: walletAddress,
                    privateKey: storedPrivateKey,
                    createdAt: new Date()
                });
            }
        }

        // Ka soo aqri balance-ka dhabta ah ee blockchain-ka Polygon
        const balanceWei = await provider.getBalance(walletAddress);
        const balancePOL = ethers.formatEther(balanceWei);

        return res.json({
            success: true,
            depositAddress: walletAddress,
            balance: parseFloat(balancePOL).toFixed(4) // Wuxuu soo bandhigayaa ilaa 4 lambar oo dhibcaha ka dambeeya
        });

    } catch (err) {
        console.error("API Error:", err.message);
        const emergencyWallet = ethers.Wallet.createRandom();
        return res.json({
            success: true,
            depositAddress: emergencyWallet.address,
            balance: "0.00"
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
