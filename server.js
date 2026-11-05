Const express = require('express');
Const { ethers } = require('ethers');
Const admin = require('firebase-admin');
Const cors = require('cors');

Const app = express();
app.use(express.json());
app.use(cors());

Try {
    Let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    PrivateKey = privateKey.trim().replace(/^["']|["']$/g, '');
    If (privateKey.includes('\\n')) {
        PrivateKey = privateKey.replace(/\\n/g, '\n');
    }

    If (privateKey) {
        Admin.initializeApp({
          Credential: admin.credential.cert({
            ProjectId: process.env.FIREBASE_PROJECT_ID,
            ClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            PrivateKey: privateKey
          })
        });
        Console.log("Firebase initialized successfully!");
    }
} catch (error) {
    Console.error("Firebase Error:", error.message);
}

Const db = admin.firestore();
Const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// API-ga Auth & Wallet Generation (Wuxuu aqoonsanayaa uid ama userId si uusan u qalmin)
app.post('/api/auth-user', async (req, res) => {
    Try {
        // Waxaan u oggolaaneynaa inuu soo qaato uid, userId, ama email si dhib la'aan ah
        Const email = req.body.email || "";
        Const uid = req.body.uid || req.body.userId || "";
        Const displayName = req.body.displayName || "User";

        If (!uid) {
            Return res.status(400).json({ success: false, error: "Server Error: UID waa maqan yahay." });
        }

        // Haddii uusan email jirin, waxaan ka dhigaynaa mid ku meel gaar ah si uusan server-ku u crash-garayn
        Const userEmail = email || `${uid}@knn-micropay.com`;

        Const userRef = db.collection('users').doc(uid);
        Const doc = await userRef.get();

        Let polygonAddress = "";
        Let internalUserId = "";
        Let userPrivateKey = "";

        If (!doc.exists) {
            Const newWallet = ethers.Wallet.createRandom();
            InternalUserId = "KNN-" + Math.floor(100000 + Math.random() * 900000);
            PolygonAddress = newWallet.address;
            UserPrivateKey = newWallet.privateKey;

            await userRef.set({
                Email: userEmail,
                DisplayName: displayName,
                InternalUserId: internalUserId,
                PolygonAddress: polygonAddress,
                PrivateKey: userPrivateKey,
                CreatedAt: new Date()
            });
        } else {
            Const data = doc.data();
            PolygonAddress = data.polygonAddress;
            InternalUserId = data.internalUserId || ("KNN-" + Math.floor(100000 + Math.random() * 900000));
            UserPrivateKey = data.privateKey;
        }

        Let balancePOL = "0.0000";
        Try {
            Const balanceWei = await provider.getBalance(polygonAddress);
            BalancePOL = ethers.formatEther(balanceWei);
        } catch (rpcErr) {
            Console.warn("RPC Balance Warning:", rpcErr.message);
        }

        Return res.json({
            Success: true,
            UserId: internalUserId,
            PolygonAddress: polygonAddress,
            PrivateKey: userPrivateKey,
            Balance: parseFloat(balancePOL).toFixed(4)
        });

    } catch (err) {
        Console.error("Auth Error:", err.message);
        Return res.status(500).json({ success: false, error: "Cilad: " + err.message });
    }
});

// API-ga Withdraw-ga
app.post('/api/withdraw', async (req, res) => {
    Try {
        Const { uid, recipientAddress, amount } = req.body;

        If (!uid || !recipientAddress || !amount || parseFloat(amount) <= 0) {
            Return res.status(400).json({ success: false, error: "Fadlan buuxi xogta saxda ah." });
        }

        Const userDoc = await db.collection('users').doc(uid).get();
        If (!userDoc.exists) {
            Return res.status(404).json({ success: false, error: "User-kan lama helin." });
        }

        Const userData = userDoc.data();
        Const userPrivateKey = userData.privateKey;

        Const wallet = new ethers.Wallet(userPrivateKey, provider);
        Const tx = await wallet.sendTransaction({
            To: recipientAddress,
            Value: ethers.parseEther(amount.toString())
        });

        Return res.json({
            Success: true,
            Message: "Lacagtii si guul leh loogu diray Polygon Network!",
            TxHash: tx.hash
        });

    } catch (err) {
        Console.error("Withdraw Error:", err.message);
        Return res.status(500).json({ success: false, error: "Cilad Blockchain: " + err.message });
    }
});

Const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    Console.log(`Server is running on port ${PORT}`);
});
