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

// Polygon RPC Provider oo la cusboonaysiiyay (PublicNode oo aad u degdeg badan)
const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// Cinwaankaaga sugan ee go'an
const FIXED_WALLET_ADDRESS = "0x44a712fdbAF5Cbdbd2960D29d576b2e808B0D5A0";

app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        let walletAddress = FIXED_WALLET_ADDRESS;

        // Ka soo aqri balance-ka dhabta ah ee blockchain-ka Polygon cinwaankaaga sugan
        const balanceWei = await provider.getBalance(walletAddress);
        const balancePOL = ethers.formatEther(balanceWei);

        return res.json({
            success: true,
            depositAddress: walletAddress,
            balance: parseFloat(balancePOL).toFixed(4) // Wuxuu soo bandhigayaa ilaa 4 lambar oo dhibcaha ka dambeeya
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
