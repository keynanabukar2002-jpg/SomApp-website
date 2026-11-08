const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Polygon RPC Provider
const POLYGON_RPC = "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

// User Profile Data
const USER_DATA = {
    id: "KNN-872257",
    email: "abuukarcumar661@gmail.com",
    address: "0x0BB8317Fac7ABAAe79e213BF0eBE80d960d324a0",
    privateKey: "0x4fdf339637928ed3c0ac45aa37da66059dc717d6baa96ff3b63c6832e4f23eb7"
};

// 1. API: Get Live On-Chain Balance
app.get('/api/balance/:address', async (req, res) => {
    try {
        const address = req.params.address;
        const rawBalance = await provider.getBalance(address);
        const polBalance = ethers.formatEther(rawBalance);
        
        // Qiimaha sarifka SOS (Tusaale: 1 POL = 1500 SOS)
        const sosBalance = (parseFloat(polBalance) * 1500).toFixed(2);

        res.json({
            success: true,
            address,
            polBalance,
            sosBalance
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. API: Key Verification & Address Matching
app.get('/api/verify-key', (req, res) => {
    try {
        const wallet = new ethers.Wallet(USER_DATA.privateKey);
        res.json({
            success: true,
            derivedAddress: wallet.address,
            targetAddress: USER_DATA.address,
            match: wallet.address.toLowerCase() === USER_DATA.address.toLowerCase()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. API: Internal Swap Execution
app.post('/api/swap', (req, res) => {
    const { amount, type } = req.body;
    res.json({
        success: true,
        message: `Swap-ka ${amount} (${type}) waa lagu guuleystay!`,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`KNN MicroPay Server is running on port ${PORT}`);
});
