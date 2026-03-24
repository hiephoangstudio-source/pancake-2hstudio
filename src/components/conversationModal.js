import { apiGet } from '../utils/api.js';
import { fmtDate } from '../utils/format.js';

let overlayEl = null;

export function openConversationModal(customer) {
    closeConversationModal();

    const name = customer.name || 'Khách hàng';
    const customerId = customer.pancake_id || customer.id;

    overlayEl = document.createElement('div');
    overlayEl.className = 'conv-modal-overlay';
    overlayEl.innerHTML = `
        <div class="conv-modal">
            <div class="conv-modal-header">
                <div>
                    <h3 style="margin:0;font-size:16px;font-weight:700">${name}</h3>
                    <span style="font-size:12px;color:var(--text-muted)">${customerId || ''}</span>
                </div>
                <button class="conv-modal-close" id="conv-modal-close">&times;</button>
            </div>
            <div class="conv-modal-body" id="conv-modal-body">
                <div style="text-align:center;padding:40px;color:var(--text-muted)">
                    <div class="spinner"></div>
                    <div style="margin-top:8px">Đang tải lịch sử tư vấn...</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlayEl);

    document.getElementById('conv-modal-close').addEventListener('click', closeConversationModal);
    overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) closeConversationModal();
    });

    loadConversations(customerId);
}

export function closeConversationModal() {
    if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
    }
}

async function loadConversations(customerId) {
    const body = document.getElementById('conv-modal-body');
    if (!body) return;

    try {
        const convs = await apiGet(`/dashboard/customer/${customerId}/conversations`);

        if (!convs || convs.length === 0) {
            body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Chưa có lịch sử hội thoại</div>';
            return;
        }

        body.innerHTML = `
            <div class="conv-list" id="conv-list">
                ${convs.map((c, i) => `
                    <div class="conv-item ${i === 0 ? 'active' : ''}" data-conv-id="${c.pancake_id}" data-customer-id="${customerId}">
                        <div class="conv-item-header">
                            <span class="conv-staff">${c.user_name || 'Chưa gán'}</span>
                            <span class="conv-date">${fmtDate(c.date)}</span>
                        </div>
                        <div class="conv-snippet">${stripHtml(c.snippet || 'Không có nội dung')}</div>
                        <div class="conv-tags">
                            ${(c.tags || []).slice(0, 3).map(t => `<span class="tag" style="font-size:10px">${t}</span>`).join(' ')}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="conv-messages" id="conv-messages">
                <div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px">
                    ← Chọn hội thoại để xem tin nhắn
                </div>
            </div>
        `;

        document.querySelectorAll('.conv-item').forEach(el => {
            el.addEventListener('click', () => {
                document.querySelectorAll('.conv-item').forEach(e => e.classList.remove('active'));
                el.classList.add('active');
                loadMessages(el.dataset.customerId);
            });
        });

        // Auto-load messages for first conversation
        if (convs.length > 0) {
            loadMessages(customerId);
        }
    } catch (err) {
        body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red)">${err.message}</div>`;
    }
}

async function loadMessages(customerId) {
    const msgEl = document.getElementById('conv-messages');
    if (!msgEl) return;

    msgEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)"><div class="spinner"></div></div>';

    try {
        const messages = await apiGet(`/dashboard/customer/${customerId}/messages?limit=200`);

        if (!messages || messages.length === 0) {
            msgEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Chưa có tin nhắn (cần page token để đồng bộ)</div>';
            return;
        }

        msgEl.innerHTML = `
            <div class="msg-list">
                ${messages.map(m => {
                    const isPage = m.sender_type === 'page';
                    return `
                        <div class="msg-bubble ${isPage ? 'msg-page' : 'msg-customer'}">
                            <div class="msg-sender">${m.sender_name || (isPage ? 'Trang' : 'Khách')}</div>
                            <div class="msg-content">${escapeHtml(m.content || '')}</div>
                            ${m.attachments && m.attachments !== '[]' ? renderAttachments(m.attachments) : ''}
                            <div class="msg-time">${formatMsgTime(m.created_at)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        msgEl.scrollTop = msgEl.scrollHeight;
    } catch (err) {
        msgEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--red)">${err.message}</div>`;
    }
}

function renderAttachments(attachments) {
    try {
        const atts = typeof attachments === 'string' ? JSON.parse(attachments) : attachments;
        if (!Array.isArray(atts) || atts.length === 0) return '';
        return atts.map(a => {
            if (a.type === 'image' || a.image_data) {
                const url = a.image_data?.url || a.payload?.url || a.url || '';
                return url ? `<div class="msg-attachment"><img src="${url}" alt="Ảnh" style="max-width:200px;border-radius:8px" /></div>` : '';
            }
            return `<div class="msg-attachment" style="font-size:11px;color:var(--text-muted)">[${a.type || 'Tệp đính kèm'}]</div>`;
        }).join('');
    } catch { return ''; }
}

function stripHtml(str) {
    return str.replace(/<[^>]*>/g, '').trim() || 'Không có nội dung';
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function formatMsgTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
