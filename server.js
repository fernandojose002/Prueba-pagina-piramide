const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());

// Servir archivos estáticos (HTML, CSS, JS, imágenes) directamente desde la raíz del proyecto
app.use(express.static(__dirname));

// Configuración de la carpeta para guardar las capturas de pantalla de los comprobantes
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'comprobante-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_super_segura_adb';

// --- BASE DE DATOS PERSISTENTE EN ARCHIVO DATA.JSON ---
const DB_FILE = path.join(__dirname, 'data.json');

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = { users: [], payments: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
        return initialData;
    }
    try {
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        return { users: [], payments: [] };
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Función para calcular ganancias acumuladas (3.5% diario) de TODOS los dispositivos activos
function calculateRewards(user) {
    if (!user.activeSubscriptions || user.activeSubscriptions.length === 0) {
        return { totalEarned: 0, activeCount: 0, totalInvestment: 0 };
    }

    const now = new Date().getTime();
    let totalEarned = 0;
    let totalInvestment = 0;

    user.activeSubscriptions.forEach(sub => {
        const approvedTime = new Date(sub.approvedAt).getTime();
        const diffMs = now - approvedTime;

        if (diffMs > 0) {
            const dailyRate = 0.035; // 3.5% diario
            const earningsPerMs = (sub.amount * dailyRate) / (1000 * 60 * 60 * 24);
            totalEarned += diffMs * earningsPerMs;
        }
        totalInvestment += sub.amount;
    });

    return {
        totalEarned: parseFloat(totalEarned.toFixed(8)),
        activeCount: user.activeSubscriptions.length,
        totalInvestment
    };
}

// 1. REGISTRO
app.post('/api/auth/register', async (req, res) => {
    try {
        const db = readDB();
        const { email, password, referralCode } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

        const existingUser = db.users.find(u => u.email === email.toLowerCase());
        if (existingUser) return res.status(400).json({ error: 'El correo ya está registrado' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const ownReferralCode = 'REF-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        let referrerId = null;
        if (referralCode) {
            const referrer = db.users.find(u => u.ownReferralCode === referralCode.trim().toUpperCase());
            if (referrer) referrerId = referrer.id;
        }

        const newUser = {
            id: db.users.length + 1,
            email: email.toLowerCase(),
            password: hashedPassword,
            ownReferralCode: ownReferralCode,
            referredBy: referrerId,
            walletAddress: '',
            activeSubscriptions: [],
            role: email.toLowerCase().includes('admin') ? 'ADMIN' : 'USER',
            createdAt: new Date().toLocaleDateString()
        };

        db.users.push(newUser);
        saveDB(db);

        const token = jwt.sign({ userId: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
        return res.status(201).json({ token, user: newUser });
    } catch (error) {
        return res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// 2. INICIO DE SESIÓN
app.post('/api/auth/login', async (req, res) => {
    try {
        const db = readDB();
        const { email, password } = req.body;
        const user = db.users.find(u => u.email === email.toLowerCase());

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        const rewards = calculateRewards(user);

        return res.json({ token, user: { ...user, rewards } });
    } catch (error) {
        return res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

// 3. OBTENER PERFIL DE USUARIO
app.get('/api/user/profile/:id', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.id == req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const rewards = calculateRewards(user);
    res.json({ user, rewards });
});

// 4. PANEL DE REFERIDOS
app.get('/api/user/referrals/:id', (req, res) => {
    const db = readDB();
    const userId = req.params.id;
    const user = db.users.find(u => u.id == userId);

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const referredUsers = db.users.filter(u => u.referredBy == userId);

    let totalCommissions = 0;
    const referralList = referredUsers.map(ref => {
        const approvedPayments = db.payments.filter(p => p.userId == ref.id && p.status === 'APROBADO');
        let commission = 0;
        let planStatus = 'Sin Plan Activo';

        if (approvedPayments.length > 0) {
            const totalSpent = approvedPayments.reduce((acc, curr) => acc + curr.amount, 0);
            commission = parseFloat((totalSpent * 0.10).toFixed(2));
            totalCommissions += commission;
            planStatus = `${approvedPayments.length} Dispositivo(s) Activo(s)`;
        }

        return {
            email: ref.email,
            registeredAt: ref.createdAt,
            planStatus: planStatus,
            commission: commission
        };
    });

    res.json({
        ownReferralCode: user.ownReferralCode,
        totalReferrals: referredUsers.length,
        totalCommissions: parseFloat(totalCommissions.toFixed(2)),
        referrals: referralList
    });
});

// 5. GUARDAR / ACTUALIZAR BILLETERA USDT
app.post('/api/user/wallet', (req, res) => {
    const db = readDB();
    const { userId, walletAddress } = req.body;
    const user = db.users.find(u => u.id == userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    user.walletAddress = walletAddress.trim();
    saveDB(db);

    return res.json({ message: 'Billetera actualizada correctamente', walletAddress: user.walletAddress });
});

// 6. ENVIAR COMPROBANTE DE PAGO
app.post('/api/payments/verify', upload.single('receiptImage'), (req, res) => {
    try {
        const db = readDB();
        const { userId, deviceName, txid, amount } = req.body;
        if (!req.file) return res.status(400).json({ error: 'Debes adjuntar una captura del comprobante.' });

        const user = db.users.find(u => u.id == userId);
        const host = req.get('host');
        const protocol = req.protocol;

        const newPayment = {
            id: db.payments.length + 1,
            userId: userId,
            userEmail: user ? user.email : 'Desconocido',
            deviceName,
            txid,
            amount: parseFloat(amount),
            receiptUrl: `${protocol}://${host}/uploads/${req.file.filename}`,
            status: 'PENDIENTE',
            submittedAt: new Date().toLocaleString()
        };

        db.payments.push(newPayment);
        saveDB(db);

        return res.status(200).json({ message: 'Comprobante recibido con éxito.', payment: newPayment });
    } catch (error) {
        return res.status(500).json({ error: 'Error al procesar el comprobante de pago.' });
    }
});

// 7. RUTAS ADMINISTRATIVAS
app.get('/api/admin/payments', (req, res) => {
    const db = readDB();
    res.json(db.payments);
});

app.post('/api/admin/payments/status', (req, res) => {
    const db = readDB();
    const { paymentId, newStatus } = req.body;
    const payment = db.payments.find(p => p.id == paymentId);
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado.' });

    payment.status = newStatus;

    if (newStatus === 'APROBADO') {
        const user = db.users.find(u => u.id == payment.userId);
        if (user) {
            if (!user.activeSubscriptions) user.activeSubscriptions = [];

            const now = new Date();
            const expiresDate = new Date();
            expiresDate.setDate(expiresDate.getDate() + 30);

            user.activeSubscriptions.push({
                subId: user.activeSubscriptions.length + 1,
                deviceName: payment.deviceName,
                amount: payment.amount,
                approvedAt: now,
                expiresAt: expiresDate
            });
        }
    }

    saveDB(db);
    return res.json({ message: `Pago ${newStatus} exitosamente.`, payment });
});

// Arrancar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de ADB Cloud Rent corriendo en http://localhost:${PORT}`));