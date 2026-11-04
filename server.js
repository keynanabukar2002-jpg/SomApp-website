const express = require('express');
const { ethers } = require('ethers');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Isticmaalka Environment Variables ee Railway (Ma raadinayo fayl dibadda ah)
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  })
});

const db = admin.firestore();
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

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
    console.log(`Server wuxuu ka shaqeynayaa port ${PORT}`);
});
