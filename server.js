const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

try {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    
    // Nadiifinta iyo toosinta Private Key-ga si uusan Node.js u diidin
    privateKey = privateKey.trim();
    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
        privateKey = privateKey.slice(1, -1);
    }
    
    // Hubinta iyo soo celinta safafka saxda ah ee furaha
    privateKey = privateKey.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

    if (privateKey) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
          })
        });
        console.log("Firebase initialized successfully!");
    } else {
        console.error("Firebase Private Key is missing!");
    }
} catch (error) {
    console.error("Firebase Error:", error.message);
}

const db = admin.firestore();
const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// API-ga Auth & Wallet Generation
app.post('/api/auth-user', async (req, res) => {
    try {
        const email = req.body.email || "";
        const uid = req.body.uid || req.body.userId || "";
        const displayName = req.body.displayName || "User";

        if (!uid) {
            return res.status(400).json({ success: false, error: "Server Error: UID waa maqan yahay." });
        }

        const userEmail = email || `${uid}@knn-micropay.com`;
        const userRef = db.collection('users').doc(uid);
        const doc = await userRef.get();

        let polygonAddress = "";
        let internalUserId = "";
        let userPrivateKey = "";

        if (!doc.exists) {
            const newWallet = ethers.Wallet.createRandom();
            internalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            polygonAddress = newWallet.address;
            userPrivateKey = newWallet.privateKey;

            await userRef.set({
                email: userEmail,
                displayName: displayName,
                internalUserId: internalUserId,
                polygonAddress: polygonAddress,
                privateKey: userPrivateKey,
                createdAt: new Date()
            });
        } else {
            const data = doc.data();
            polygonAddress = data.polygonAddress;
            internalUserId = data.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            userPrivateKey = data.privateKey;
        }

        let balancePOL = "0.0000";
        try {
            const balanceWei = await provider.getBalance(polygonAddress);
            balancePOL = ethers.formatEther(balanceWei);
        } catch (rpcErr) {
            console.warn("RPC Balance Warning:", rpcErr.message);
        }

        return res.json({
            success: true,
            userId: internalUserId,
            polygonAddress: polygonAddress,
            privateKey: userPrivateKey,
            balance: parseFloat(balancePOL).toFixed(4)
        });

    } catch (err) {
        console.error("Auth Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Server: " + err.message });
    }
});

// API-ga Withdraw-ga
app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;

        if (!uid || !recipientAddress || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: "Fadlan buuxi xogta saxda ah." });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, error: "User-kan lama helin." });
        }

        const userData = userDoc.data();
        const userPrivateKey = userData.privateKey;

        const wallet = new ethers.Wallet(userPrivateKey, provider);
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(amount.toString())
        });

        return res.json({
            success: true,
            message: "Lacagtii si guul leh loogu diray Polygon Network!",
            txHash: tx.hash
        });

    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad Blockchain: " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
