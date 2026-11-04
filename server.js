const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Ku xiridda Firebase Admin SDK (Hubi in serviceAccountKey.json uu isla folder-ka ku jiro)
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Ku xiridda Polygon RPC
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

// API-ga lagu abuurayo ama lagu soo celinayo cinwaanka user-ka
app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: "Email waa qasab!" });

        const userRef = db.collection('users').doc(email);
        const userSnap = await userRef.get();

        if (userSnap.exists) {
            const userData = userSnap.data();
            return res.json({
                success: true,
                depositAddress: userData.depositAddress,
                balance: userData.balance
            });
        } else {
            // Abuurista cinwaan cusub oo Polygon ah oo u gaar ah user-ka (FaucetPay style)
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
    console.log(`Server-kii micro-wallet wuxuu ka shaqeynayaa port ${PORT}`);
});
