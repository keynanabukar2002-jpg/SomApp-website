const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const DB_FILE = path.join(__dirname, 'users-db.json');
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

// Akoonkaaga la xiray
const LOCKED_OWNER_EMAIL = 'abuukarcumar661@gmail.com';
const LOCKED_OWNER_ACCOUNT_ID = 'KNN-205792';
const LOCKED_OWNER_ADDRESS = ethers.getAddress('0x613b603440CA724C266FC5432E2a20D000F73367');

function normalizePrivateKey(rawKey) {
    if (!rawKey) return '';
    let cleaned = String(rawKey).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
    if (!cleaned.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(cleaned)) {
        cleaned = '0x' + cleaned;
    }
    return cleaned;
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
        return derivedWallet.address.toLowerCase() === ethers.getAddress(address.trim()).toLowerCase();
    } catch (_) {
        return false;
    }
}

function isLockedOwner(email) {
    return String(email || '').trim().toLowerCase() === LOCKED_OWNER_EMAIL.toLowerCase();
}

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
        exists = userId === LOCKED_OWNER_ACCOUNT_ID || Object.values(usersDb).some(u => u.userId === userId);
    }
    return userId;
}

app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID waa loo baahan yahay' });
        }

        const usersDb = loadUsersDb();
        const existing = usersDb[uid];
        const effectiveEmail = (email || existing?.email || '').trim();

        if (isLockedOwner(effectiveEmail)) {
            // Xir KNN-205792 iyo 0x613b603440CA724C266FC5432E2a20D000F73367 si aysan is beddelin
            const existingKey = normalizePrivateKey(existing?.privateKey || '');
            const envKey = normalizePrivateKey(process.env.MAIN_WALLET_PRIVATE_KEY || '');

            let chosenKey = '';
            if (isValidPrivateKey(existingKey) && isWalletPairValid(LOCKED_OWNER_ADDRESS, existingKey)) {
                chosenKey = existingKey;
            } else if (isValidPrivateKey(envKey) && isWalletPairValid(LOCKED_OWNER_ADDRESS, envKey)) {
                chosenKey = envKey;
            } else if (isValidPrivateKey(existingKey)) {
                chosenKey = existingKey;
            } else if (isValidPrivateKey(envKey)) {
                chosenKey = envKey;
            }

            usersDb[uid] = {
                uid,
                email: effectiveEmail || LOCKED_OWNER_EMAIL,
                displayName: displayName || existing?.displayName || 'Abuukar Cumar',
                userId: LOCKED_OWNER_ACCOUNT_ID,
                polygonAddress: LOCKED_OWNER_ADDRESS,
                privateKey: chosenKey,
                walletLocked: true,
                balance: existing?.balance || '0',
                dailyLimit: existing?.dailyLimit || '0',
                miningActive: Boolean(existing?.miningActive || false),
                createdAt: existing?.createdAt || Date.now()
            };

            saveUsersDb(usersDb);
        } else {
            // Dadka kale: hal mar samee wallet cusub oo run ah, ka dibna xir si uusan is beddelin
            const hasValidLockedWallet =
                existing &&
                existing.userId &&
                existing.walletLocked === true &&
                isWalletPairValid(existing.polygonAddress, existing.privateKey);

            if (!hasValidLockedWallet) {
                const wallet = ethers.Wallet.createRandom();
                const newUserId = generateUniqueAccountId(usersDb);

                usersDb[uid] = {
                    uid,
                    email: effectiveEmail,
                    displayName: displayName || 'User',
                    userId: newUserId,
                    polygonAddress: ethers.getAddress(wallet.address),
                    privateKey: wallet.privateKey,
                    walletLocked: true,
                    balance: '0',
                    dailyLimit: '0',
                    miningActive: false,
                    createdAt: Date.now()
                };

                saveUsersDb(usersDb);
            } else {
                if (effectiveEmail) usersDb[uid].email = effectiveEmail;
                if (displayName) usersDb[uid].displayName = displayName;
                usersDb[uid].walletLocked = true;
                saveUsersDb(usersDb);
            }
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
        if (!recipientAddress || !ethers.isAddress(recipientAddress)) {
            return res.status(400).json({ success: false, error: 'Cinwaanka recipient-ka waa qalad' });
        }
        if (!isValidPrivateKey(userRecord.privateKey)) {
            return res.status(400).json({ success: false, error: 'Private key-ga akoonkan waa qalad ama lama helin' });
        }

        const signer = new ethers.Wallet(userRecord.privateKey.trim(), provider);
        const onChainBalanceWei = await provider.getBalance(signer.address);
        const onChainBalancePol = Number(ethers.formatEther(onChainBalanceWei));

        const requestedPol = amount !== undefined && amount !== null && String(amount).trim() !== ''
            ? parseFloat(amount)
            : onChainBalancePol;

        if (isNaN(requestedPol) || requestedPol <= 0) {
            return res.status(400).json({ success: false, error: 'Qaddarka withdraw waa inuu ka weynaado 0' });
        }

        const amountWei = ethers.parseEther(requestedPol.toFixed(8));
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
            to: ethers.getAddress(recipientAddress.trim()),
            value: amountWei,
            gasLimit,
            maxFeePerGas
        });

        await tx.wait(1);

        const updatedWei = await provider.getBalance(signer.address);
        const updatedPol = ethers.formatEther(updatedWei);
        userRecord.balance = updatedPol;
        saveUsersDb(usersDb);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol.toFixed(8)} POL! Tx: ${tx.hash}`,
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
