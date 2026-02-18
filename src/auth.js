const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { stmts } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'streetos-secret-key-change-in-prod';
const STARTING_CASH = 100000;

function register(username, password) {
    if (!username || !password) throw new Error('Username and password required');
    if (username.length < 3) throw new Error('Username must be at least 3 characters');
    if (password.length < 4) throw new Error('Password must be at least 4 characters');

    const existing = stmts.getUserByUsername.get(username.toLowerCase());
    if (existing) throw new Error('Username already taken');

    const id = uuid();
    const hash = bcrypt.hashSync(password, 10);
    stmts.insertUser.run(id, username.toLowerCase(), hash, STARTING_CASH, STARTING_CASH);

    const token = jwt.sign({ id, username: username.toLowerCase() }, JWT_SECRET, { expiresIn: '7d' });
    return { token, user: { id, username: username.toLowerCase(), cash: STARTING_CASH } };
}

function login(username, password) {
    if (!username || !password) throw new Error('Username and password required');

    const user = stmts.getUserByUsername.get(username.toLowerCase());
    if (!user) throw new Error('Invalid credentials');

    if (!bcrypt.compareSync(password, user.password_hash)) throw new Error('Invalid credentials');

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    return { token, user: { id: user.id, username: user.username, cash: user.cash, role: user.role } };
}

function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

module.exports = { register, login, authenticate, verifyToken, JWT_SECRET };
