const express = require('express');
const { v4: uuid } = require('uuid');
const { stmts } = require('./db');
const { authenticate } = require('./auth');

const router = express.Router();

// ─── Firms ─────────────────────────────────────────────────────────────────────

// Create a firm
router.post('/', authenticate, (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    // Check if user is already in a firm? (Optional rule: 1 firm per user?)
    // For now, let's say a user can only OWN one firm, or be in one firm.
    const existingMembership = stmts.getUserFirm.get(req.user.id);
    if (existingMembership) {
        return res.status(400).json({ error: 'You are already a member of a firm' });
    }

    try {
        const firmId = uuid();

        const tx = stmts.db.transaction(() => {
            stmts.createFirm.run(firmId, name, req.user.id, description || '');
            stmts.addFirmMember.run(firmId, req.user.id, 'manager'); // Owner is manager
        });

        tx();

        res.json({ success: true, firmId });
    } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Firm name already taken' });
        }
        res.status(500).json({ error: e.message });
    }
});

// List all firms
router.get('/', (req, res) => {
    const firms = stmts.getAllFirms.all();
    // Maybe populate member counts?
    const result = firms.map(f => {
        const members = stmts.getFirmMembers.all(f.id);
        return { ...f, memberCount: members.length, owner: members.find(m => m.role === 'manager')?.username };
    });
    res.json(result);
});

// Get my firm
router.get('/me', authenticate, (req, res) => {
    const membership = stmts.getUserFirm.get(req.user.id);
    if (!membership) return res.json(null);

    const firm = stmts.getFirmById.get(membership.firm_id);
    const members = stmts.getFirmMembers.all(membership.firm_id);

    res.json({ ...firm, myRole: membership.role, members });
});

// Get specific firm
router.get('/:id', (req, res) => {
    const firm = stmts.getFirmById.get(req.params.id);
    if (!firm) return res.status(404).json({ error: 'Firm not found' });

    const members = stmts.getFirmMembers.all(req.params.id);
    res.json({ ...firm, members });
});

// Invite member
router.post('/:id/invite', authenticate, (req, res) => {
    const { username } = req.body;
    const firmId = req.params.id;

    // Check permissions
    const membership = stmts.getFirmMember.get(firmId, req.user.id);
    if (!membership || membership.role !== 'manager') {
        return res.status(403).json({ error: 'Only managers can invite' });
    }

    const invitee = stmts.getUserByUsername.get(username);
    if (!invitee) return res.status(404).json({ error: 'User not found' });

    // Check if already in a firm
    const existing = stmts.getUserFirm.get(invitee.id);
    if (existing) return res.status(400).json({ error: 'User is already in a firm' });

    // Check if already invited
    const pending = stmts.getPendingInvitations.get(username);
    if (pending) return res.status(400).json({ error: 'User has pending invitations' });

    const inviteId = uuid();
    stmts.createFirmInvitation.run(inviteId, firmId, req.user.id, username);

    res.json({ success: true, message: `Invited ${username}` });
});

// List invitations for me
router.get('/invitations/me', authenticate, (req, res) => {
    const user = stmts.getUserById.get(req.user.id);
    const invites = stmts.getPendingInvitations.all(user.username);
    // Enrich with firm names
    const result = invites.map(i => {
        const firm = stmts.getFirmById.get(i.firm_id);
        return { ...i, firmName: firm.name };
    });
    res.json(result);
});

// Accept/Reject invitation
router.post('/invitations/:id/:action', authenticate, (req, res) => {
    const { id, action } = req.params;
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const invite = stmts.getFirmInvitation.get(id);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    const user = stmts.getUserById.get(req.user.id);
    if (invite.invitee_username !== user.username) return res.status(403).json({ error: 'Not your invitation' });

    if (action === 'reject') {
        stmts.updateInvitationStatus.run('rejected', id);
        return res.json({ success: true, message: 'Invitation rejected' });
    }

    // Accept
    const tx = stmts.db.transaction(() => {
        stmts.updateInvitationStatus.run('accepted', id);
        stmts.addFirmMember.run(invite.firm_id, req.user.id, 'member');
    });

    try {
        tx();
        res.json({ success: true, message: 'Joined firm' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Leave firm
router.post('/leave', authenticate, (req, res) => {
    const membership = stmts.getUserFirm.get(req.user.id);
    if (!membership) return res.status(400).json({ error: 'Not in a firm' });

    if (membership.role === 'manager') {
        // If owner leaves, maybe destroy firm or reassign? simple: don't allow if only one manager
        // For now, let's just delete the member. If it's the last member, maybe delete firm?
    }

    stmts.removeFirmMember.run(membership.firm_id, req.user.id);
    res.json({ success: true });
});

module.exports = router;
