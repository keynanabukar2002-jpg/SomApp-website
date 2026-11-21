const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'users-db.json');
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

function loadUsersDb() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2));
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
        console.error('DB load error:', err);
        return {};
    }
}

function saveUsersDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function generateUniqueAccountId(usersDb) {
    let userId = '';
    let exists = true;
    while (exists) {
        const randomSix = Math.floor(100000 + Math.random() * 900000);
        userId = `KNN-${randomSix}`;
        exists = Object.values(usersDb).some(u => u.userId === userId);
    }
    return userId;
}

function isValidPrivateKey(pk) {
    return typeof pk === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pk.trim());
}

function isWalletPairValid(address, privateKey) {
    if (!ethers.isAddress(address) || !isValidPrivateKey(privateKey)) {
        return false;
    }
    try {
        const derivedWallet = new ethers.Wallet(privateKey.trim());
        return derivedWallet.address.toLowerCase() === address.trim().toLowerCase();
    } catch (_) {
        return false;
    }
}

app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID waa loo baahan yahay' });
        }

        const usersDb = loadUsersDb();
        const existing = usersDb[uid];

        // Haddii uu horay u lahaa wallet sax ah oo isku toosan, ha beddelin (xitaa refresh ama logout ka dib)
        const hasValidLockedWallet =
            existing &&
            existing.userId &&
            isWalletPairValid(existing.polygonAddress, existing.privateKey);

        if (!hasValidLockedWallet) {
            const wallet = ethers.Wallet.createRandom();
            const newUserId = generateUniqueAccountId(usersDb);

            usersDb[uid] = {
                uid,
                email: email || '',
                displayName: displayName || 'User',
                userId: newUserId,
                polygonAddress: wallet.address,
                privateKey: wallet.privateKey,
                walletLocked: true,
                balance: '0',
                dailyLimit: '0',
                miningActive: false,
                createdAt: Date.now()
            };

            saveUsersDb(usersDb);
        } else {
            if (email) usersDb[uid].email = email;
            if (displayName) usersDb[uid].displayName = displayName;
            usersDb[uid].walletLocked = true;
            saveUsersDb(usersDb);
        }

        const userRecord = usersDb[uid];

        return res.json({
            success: true,
            userId: userRecord.userId,
            polygonAddress: userRecord.polygonAddress,
            privateKey: userRecord.privateKey,
            balance: userRecord.balance,
            dailyLimit: userRecord.dailyLimit,
            miningActive: userRecord.miningActive
        });
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ success: false, error: 'Cilad server ayaa dhacday' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { uid, recipientAddress, amount } = req.body;
        const usersDb = loadUsersDb();
        const userRecord = usersDb[uid];

        if (!userRecord) {
            return res.status(404).json({ success: false, error: 'Xisaabta lama helin' });
        }
        if (!ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ success: false, error: 'Cinwaanka recipient-ka waa qalad' });
        }
        if (!isWalletPairValid(userRecord.polygonAddress, userRecord.privateKey)) {
            return res.status(400).json({ success: false, error: 'Private key ama address-ka akoonkan waa qalad' });
        }

        const signer = new ethers.Wallet(userRecord.privateKey.trim(), provider);
        const onChainBalanceWei = await provider.getBalance(signer.address);
        const onChainBalancePol = Number(ethers.formatEther(onChainBalanceWei));

        const requestedPol = amount ? Number(amount) : onChainBalancePol;
        if (isNaN(requestedPol) || requestedPol <= 0) {
            return res.status(400).json({ success: false, error: 'Qaddarka withdraw waa inuu ka weynaado 0' });
        }

        const amountWei = ethers.parseEther(requestedPol.toString());
        const feeData = await provider.getFeeData();
        const gasLimit = 21000n;
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei');
        const totalGasCostWei = gasLimit * maxFeePerGas;

        if (onChainBalanceWei < amountWei + totalGasCostWei) {
            return res.status(400).json({
                success: false,
                error: `Hadhaaga on-chain ee wallet-kaaga (${onChainBalancePol.toFixed(8)} POL) kuma filna qaddarka iyo gas-ka`
            });
        }

        const tx = await signer.sendTransaction({
            to: recipientAddress,
            value: amountWei,
            gasLimit,
            maxFeePerGas
        });

        await tx.wait();

        const updatedWei = await provider.getBalance(signer.address);
        const updatedPol = ethers.formatEther(updatedWei);
        userRecord.balance = updatedPol;
        saveUsersDb(usersDb);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol} POL! Tx: ${tx.hash}`,
            newBalance: updatedPol,
            txHash: tx.hash
        });
    } catch (err) {
        console.error('Withdraw error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Cilad blockchain ayaa dhacday' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
