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

// Polygon RPC Provider oo hufan
const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// Cinwaankaaga sugan
const FIXED_WALLET_ADDRESS = "0x44a712fdbAF5Cbdbd2960D29d576b2e808B0D5A0";
// ⚠️ Halkan geli Private Key-ga cinwaankaaga (sii xaqiiji inaan qof kale la wadaagin)
const FIXED_PRIVATE_KEY = process.env.FIXED_PRIVATE_KEY || "HADDII_AY JIRTO_HALKAN_GELI_PRIVATE_KEY";

// API-ga lagu soo akhriyo Balance-ka
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

// API-ga cusub ee Withdraw (Bixinta lacagta)
app.post('/api/withdraw', async (req, res) => {
    try {
        const { recipientAddress, amount } = req.body;
        
        if (!recipientAddress || !amount) {
            return res.status(400).json({ success: false, error: "Fadlan geli cinwaanka iyo xadiga lacagta." });
        }

        if (FIXED_PRIVATE_KEY.includes("HADDII_AY") || !FIXED_PRIVATE_KEY) {
            return res.status(500).json({ success: false, error: "Private key-ga server-ka laguma xirin." });
        }

        // Abuur Wallet adoo isticmaalaya Private Key-gaaga oo ku xir Provider-ka Polygon
        const wallet = new ethers.Wallet(FIXED_PRIVATE_KEY, provider);

        // Beddel lacagta POL una beddel Wei (xaqiiqda blockchain-ka)
        const amountWei = ethers.parseEther(amount.toString());

        // Dir Transaction-ka
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: amountWei
        });

        return res.json({
            success: true,
            message: "Lacagtii waa la diray!",
            txHash: tx.hash
        });

    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
