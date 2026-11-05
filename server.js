const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Polygon RPC Provider
const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");

// Cinwaanka go'an ee App-ka (Deposit & Main Address)
const APP_WALLET_ADDRESS = "0x44a712fdbAF5Cbdbd2960D29d576b2e808B0D5A0";
const DEFAULT_TARGET_ADDRESS = "0xCd39C0BC7f67faCe86E33E7E7Ac633364216722F";

// 1. API-ga Balance-ka ka akhrinaya cinwaanka app-ka
app.post('/api/get-or-create-wallet', async (req, res) => {
    try {
        const balanceWei = await provider.getBalance(APP_WALLET_ADDRESS);
        const balancePOL = ethers.formatEther(balanceWei);

        return res.json({
            success: true,
            depositAddress: APP_WALLET_ADDRESS,
            balance: parseFloat(balancePOL).toFixed(4)
        });
    } catch (err) {
        console.error("API Error:", err.message);
        return res.json({
            success: true,
            depositAddress: APP_WALLET_ADDRESS,
            balance: "0.00"
        });
    }
});

// 2. API-ga Withdraw-ga oo isticmaalaya Private Key-ga cusub
app.post('/api/withdraw', async (req, res) => {
    try {
        const recipientAddress = req.body.recipientAddress || DEFAULT_TARGET_ADDRESS;
        const amount = req.body.amount;

        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: "Fadlan geli xadiga saxda ah." });
        }

        const serverPrivateKey = process.env.FIXED_PRIVATE_KEY;

        if (!serverPrivateKey || serverPrivateKey.trim().length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: "Private Key-ga server-ka ma jiro ama waa khaldan yahay." 
            });
        }

        // Qaabeynta furaha cusub
        const cleanKey = serverPrivateKey.trim();
        const formattedKey = cleanKey.startsWith('0x') ? cleanKey : `0x${cleanKey}`;
        
        const wallet = new ethers.Wallet(formattedKey, provider);

        // U dirida lacagta cinwaanka qaataha
        const tx = await wallet.sendTransaction({
            to: recipientAddress,
            value: ethers.parseEther(amount.toString())
        });

        return res.json({
            success: true,
            message: "Lacagtii si guul leh ayaa loo diray!",
            txHash: tx.hash
        });

    } catch (err) {
        console.error("Withdraw Error:", err.message);
        return res.status(500).json({ success: false, error: "Cilad: " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
