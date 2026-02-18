const express = require('express');
const { v4: uuid } = require('uuid');
const { query, getOne, getAll } = require('./db');
const { authenticate } = require('./auth');

const router = express.Router();

// ─── Firms ─────────────────────────────────────────────────────────────────────

// Create a firm
router.post('/', authenticate, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    try {
        const existingMembership = await getOne('SELECT * FROM firm_members WHERE user_id = $1', [req.user.id]);
        if (existingMembership) {
            return res.status(400).json({ error: 'You are already a member of a firm' });
        }

        const firmId = uuid();

        // Transaction manually or just sequential (assuming low concurrency collision risk for now)
        await query('BEGIN');
        try {
            await query('INSERT INTO firms (id, name, owner_id, description) VALUES ($1, $2, $3, $4)', [firmId, name, req.user.id, description || '']);
            await query('INSERT INTO firm_members (firm_id, user_id, role) VALUES ($1, $2, $3)', [firmId, req.user.id, 'manager']);
            await query('COMMIT');
            res.json({ success: true, firmId });
        } catch (e) {
            await query('ROLLBACK');
            throw e;
        }
    } catch (e) {
        if (e.message.includes('unique constraint')) { // pg specific error handling sometimes varies, but usually includes this
            return res.status(400).json({ error: 'Firm name already taken' });
        }
        res.status(500).json({ error: e.message });
    }
});

// List all firms
router.get('/', async (req, res) => {
    try {
        const firms = await getAll('SELECT * FROM firms');
        const result = [];
        for (const f of firms) {
            const members = await getAll('SELECT * FROM firm_members WHERE firm_id = $1', [f.id]);
            const ownerMember = members.find(m => m.role === 'manager');
            const ownerUser = ownerMember ? await getOne('SELECT username FROM users WHERE id = $1', [ownerMember.user_id]) : { username: 'Unknown' };
            result.push({ ...f, memberCount: members.length, owner: ownerUser.username });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get my firm
router.get('/me', authenticate, async (req, res) => {
    try {
        const membership = await getOne('SELECT * FROM firm_members WHERE user_id = $1', [req.user.id]);
        if (!membership) return res.json(null);

        const firm = await getOne('SELECT * FROM firms WHERE id = $1', [membership.firm_id]);
        if (!firm) return res.json(null); // Should not happen due to FK

        const members = await getAll('SELECT m.*, u.username FROM firm_members m JOIN users u ON m.user_id = u.id WHERE m.firm_id = $1', [membership.firm_id]);

        res.json({ ...firm, myRole: membership.role, members });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get specific firm
router.get('/:id', async (req, res) => {
    try {
        const firm = await getOne('SELECT * FROM firms WHERE id = $1', [req.params.id]);
        if (!firm) return res.status(404).json({ error: 'Firm not found' });

        const members = await getAll('SELECT m.*, u.username FROM firm_members m JOIN users u ON m.user_id = u.id WHERE m.firm_id = $1', [req.params.id]);
        res.json({ ...firm, members });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Invite member
router.post('/:id/invite', authenticate, async (req, res) => {
    const { username } = req.body;
    const firmId = req.params.id;

    try {
        // Check permissions
        const membership = await getOne('SELECT * FROM firm_members WHERE firm_id = $1 AND user_id = $2', [firmId, req.user.id]);
        if (!membership || membership.role !== 'manager') {
            return res.status(403).json({ error: 'Only managers can invite' });
        }

        const invitee = await getOne('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
        if (!invitee) return res.status(404).json({ error: 'User not found' });

        // Check if already in a firm
        const existing = await getOne('SELECT * FROM firm_members WHERE user_id = $1', [invitee.id]);
        if (existing) return res.status(400).json({ error: 'User is already in a firm' });

        // Check if already invited
        const pending = await getOne('SELECT * FROM firm_invitations WHERE invitee_username = $1 AND status = $2', [username.toLowerCase(), 'pending']);
        if (pending) return res.status(400).json({ error: 'User has pending invitations' });

        const inviteId = uuid();
        await query('INSERT INTO firm_invitations (id, firm_id, inviter_id, invitee_username) VALUES ($1, $2, $3, $4)', [inviteId, firmId, req.user.id, username.toLowerCase()]);

        res.json({ success: true, message: `Invited ${username}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List invitations for me
router.get('/invitations/me', authenticate, async (req, res) => {
    try {
        const user = await getOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const invites = await getAll('SELECT * FROM firm_invitations WHERE invitee_username = $1 AND status = $2', [user.username, 'pending']);

        const result = [];
        for (const i of invites) {
            const firm = await getOne('SELECT name FROM firms WHERE id = $1', [i.firm_id]);
            result.push({ ...i, firmName: firm.name });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Accept/Reject invitation
router.post('/invitations/:id/:action', authenticate, async (req, res) => {
    const { id, action } = req.params;
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    try {
        const invite = await getOne('SELECT * FROM firm_invitations WHERE id = $1', [id]);
        if (!invite) return res.status(404).json({ error: 'Invitation not found' });

        const user = await getOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (invite.invitee_username !== user.username) return res.status(403).json({ error: 'Not your invitation' });

        if (action === 'reject') {
            await query('UPDATE firm_invitations SET status = $1 WHERE id = $2', ['rejected', id]);
            return res.json({ success: true, message: 'Invitation rejected' });
        }

        // Accept
        await query('BEGIN');
        try {
            await query('UPDATE firm_invitations SET status = $1 WHERE id = $2', ['accepted', id]);
            await query('INSERT INTO firm_members (firm_id, user_id, role) VALUES ($1, $2, $3)', [invite.firm_id, req.user.id, 'member']);
            await query('COMMIT');
            res.json({ success: true, message: 'Joined firm' });
        } catch (e) {
            await query('ROLLBACK');
            throw e;
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Leave firm
router.post('/leave', authenticate, async (req, res) => {
    try {
        const membership = await getOne('SELECT * FROM firm_members WHERE user_id = $1', [req.user.id]);
        if (!membership) return res.status(400).json({ error: 'Not in a firm' });

        // Logic for manager leaving... same as before, simplified
        await query('DELETE FROM firm_members WHERE firm_id = $1 AND user_id = $2', [membership.firm_id, req.user.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
