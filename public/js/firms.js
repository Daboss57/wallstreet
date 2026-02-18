/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Hedge Firms Module
   ═══════════════════════════════════════════════════════════════════════════════ */

const Firms = {
    myFirm: null,

    async render(container) {
        container.innerHTML = `
      <div class="firms-layout">
        <header class="firms-header">
          <h1>Hedge Firms</h1>
          <button class="btn-primary" onclick="Firms.openCreateModal()">+ Create Firm</button>
        </header>

        <div class="firms-content">
          <div class="my-firm-section" id="my-firm-section">
            <div class="loading">Loading your firm data...</div>
          </div>

          <div class="all-firms-section">
            <h2>Active Firms</h2>
            <div id="firms-list" class="firms-list"></div>
          </div>
        </div>
      </div>
    `;

        this.loadMyFirm();
        this.loadAllFirms();
    },

    async loadMyFirm() {
        try {
            const firm = await Utils.get('/firms/me');
            const el = document.getElementById('my-firm-section');
            if (!el) return;

            if (firm) {
                this.myFirm = firm;
                el.innerHTML = `
          <div class="firm-card my-firm-card">
            <div class="firm-header">
              <h3>${firm.name}</h3>
              <span class="firm-role-badge">${firm.myRole.toUpperCase()}</span>
            </div>
            <p>${firm.description || 'No description'}</p>
            <div class="firm-stats">
              <div class="stat"><span>Members</span> <b>${firm.members.length}</b></div>
              <div class="stat"><span>Since</span> <b>${new Date(firm.created_at).toLocaleDateString()}</b></div>
            </div>
            <div class="firm-members-list">
              <h4>Members</h4>
              ${firm.members.map(m => `
                <div class="firm-member-row">
                  <span>${m.username}</span>
                  <span class="role">${m.role}</span>
                </div>
              `).join('')}
            </div>
            ${firm.myRole === 'manager' ? `
              <div class="firm-actions">
                <button class="btn-sm" onclick="Firms.inviteMember('${firm.id}')">Invite Member</button>
              </div>
            ` : ''}
          </div>
        `;
            } else {
                this.myFirm = null;
                el.innerHTML = `
          <div class="no-firm-state">
            <p>You are not a member of any hedge firm.</p>
            <p>Create your own or join an existing one.</p>
            ${await this.renderInvitations()}
          </div>
        `;
            }
        } catch (e) {
            console.error(e);
        }
    },

    async renderInvitations() {
        try {
            const invites = await Utils.get('/firms/invitations/me');
            if (invites.length === 0) return '';

            return `
        <div class="invitations-list">
          <h4>Pending Invitations</h4>
          ${invites.map(i => `
            <div class="invite-card">
              <span>Invited to <b>${i.firmName}</b></span>
              <div>
                <button class="btn-xs accept" onclick="Firms.respondInvite('${i.id}', 'accept')">Accept</button>
                <button class="btn-xs reject" onclick="Firms.respondInvite('${i.id}', 'reject')">Reject</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
        } catch (e) { return ''; }
    },

    async loadAllFirms() {
        try {
            const firms = await Utils.get('/firms');
            const list = document.getElementById('firms-list');
            if (!list) return;

            list.innerHTML = firms.map(f => `
        <div class="firm-item">
          <div class="firm-info">
            <div class="firm-name">${f.name}</div>
            <div class="firm-meta">Owner: ${f.owner} • ${f.memberCount} Members</div>
          </div>
          ${this.myFirm ? '' : `<button class="btn-secondary btn-sm" onclick="alert('Ask the owner for an invite!')">Join</button>`}
        </div>
      `).join('');
        } catch (e) { console.error(e); }
    },

    openCreateModal() {
        if (this.myFirm) {
            alert('You are already in a firm!');
            return;
        }
        const name = prompt('Enter Firm Name:');
        if (!name) return;
        const desc = prompt('Enter Description (optional):');

        this.createFirm(name, desc);
    },

    async createFirm(name, description) {
        try {
            await Utils.post('/firms', { name, description });
            Utils.showToast('success', 'Firm Created', `welcome to ${name}`);
            this.render(document.getElementById('app')); // reload
        } catch (e) {
            Utils.showToast('error', 'Error', e.message);
        }
    },

    async inviteMember(firmId) {
        const username = prompt('Enter username to invite:');
        if (!username) return;

        try {
            await Utils.post(`/firms/${firmId}/invite`, { username });
            Utils.showToast('success', 'Invited', `Invite sent to ${username}`);
        } catch (e) {
            Utils.showToast('error', 'Error', e.message);
        }
    },

    async respondInvite(id, action) {
        try {
            await Utils.post(`/firms/invitations/${id}/${action}`, {});
            this.loadMyFirm();
        } catch (e) {
            Utils.showToast('error', 'Error', e.message);
        }
    }
};

window.Firms = Firms;
