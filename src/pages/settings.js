import { apiGet, apiPost, apiDelete } from '../utils/api.js';
import { toastSuccess, toastError } from '../components/toast.js';

export function destroy() {}

export async function render(container) {
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = 'Cấu hình';

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) filtersEl.innerHTML = '';

    container.innerHTML = `
        <!-- Master Token + Sync -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="settings-grid">
            <div class="card">
                <div class="chart-title"><i data-lucide="key"></i> Pancake Master Token</div>
                <p style="font-size:12px;color:var(--text-muted);margin:8px 0">Token xác thực API Pancake để đồng bộ dữ liệu.</p>
                <div id="token-status" style="font-size:12px;margin-bottom:8px"></div>
                <input id="master-token-input" placeholder="Nhập master token mới..." type="password"
                    style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;margin-bottom:8px;font-family:monospace" />
                <button class="btn btn-primary" id="save-token-btn" style="width:100%"><i data-lucide="save"></i> Lưu Token</button>
            </div>
            <div class="card">
                <div class="chart-title"><i data-lucide="refresh-cw"></i> Đồng bộ dữ liệu</div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
                    <button class="btn" id="sync-today-btn"><i data-lucide="zap"></i> Hôm nay</button>
                    <button class="btn" id="sync-week-btn"><i data-lucide="calendar"></i> 7 ngày</button>
                    <button class="btn" id="sync-month-btn"><i data-lucide="calendar-range"></i> 30 ngày</button>
                </div>
                <div id="sync-status" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
                    <div class="chart-title" style="margin-bottom:4px"><i data-lucide="user"></i> Thông tin đăng nhập</div>
                    <div id="user-info" style="font-size:12px;color:var(--text-secondary)"></div>
                </div>
            </div>
        </div>

        <!-- Pages + Tags -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px" class="settings-grid">
            <div class="card">
                <div class="chart-title"><i data-lucide="file-text"></i> Quản lý Pages (Trang Facebook)</div>
                <div id="pages-list" style="margin-top:8px">Đang tải...</div>
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
                    <h4 style="font-size:12px;font-weight:600;margin-bottom:8px">Thêm trang mới</h4>
                    <input id="new-page-id" placeholder="Page ID" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;margin-bottom:6px" />
                    <input id="new-page-name" placeholder="Tên trang" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;margin-bottom:6px" />
                    <input id="new-page-token" placeholder="Access Token" type="password" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;margin-bottom:6px" />
                    <button class="btn btn-primary" id="add-page-btn" style="width:100%">Thêm trang</button>
                </div>
            </div>
            <div class="card">
                <div class="chart-title"><i data-lucide="tag"></i> Phân loại Tags</div>
                <div id="tags-config" style="margin-top:8px">Đang tải...</div>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    // Show current user info
    try {
        const { getUser } = await import('../utils/auth.js');
        const user = getUser();
        const userInfoEl = document.getElementById('user-info');
        if (userInfoEl && user) {
            userInfoEl.innerHTML = `<strong>${user.name || 'Admin'}</strong> · ${user.role || 'admin'}`;
        }
    } catch {}

    // Check token status
    try {
        const statusEl = document.getElementById('token-status');
        const res = await apiGet('/sync/status');
        if (statusEl) {
            statusEl.innerHTML = res?.hasToken
                ? '<span style="color:var(--green)">✅ Token đã được cấu hình</span>'
                : '<span style="color:var(--red)">❌ Chưa có token — cần nhập để đồng bộ</span>';
        }
    } catch {
        const statusEl = document.getElementById('token-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted)">Không thể kiểm tra trạng thái</span>';
    }

    await loadPages();
    await loadTagConfig();

    document.getElementById('add-page-btn')?.addEventListener('click', addPage);
    document.getElementById('save-token-btn')?.addEventListener('click', saveToken);
    document.getElementById('sync-today-btn')?.addEventListener('click', () => triggerSync(1));
    document.getElementById('sync-week-btn')?.addEventListener('click', () => triggerSync(7));
    document.getElementById('sync-month-btn')?.addEventListener('click', () => triggerSync(30));
}


async function loadPages() {
    try {
        const pages = await apiGet('/pages');
        const el = document.getElementById('pages-list');
        if (!el) return;
        if (pages.length === 0) {
            el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Chưa có trang nào</div>';
            return;
        }
        el.innerHTML = `<table class="data-table"><thead><tr><th>Tên</th><th>Page ID</th><th>Token</th><th>Trạng thái</th></tr></thead><tbody>${pages.map(p => `
            <tr>
                <td style="font-weight:600">${p.name}</td>
                <td style="font-size:11px;color:var(--text-muted)">${p.page_id}</td>
                <td style="font-size:11px">${p._hasToken ? '✅ Đã cấu hình' : '❌ Chưa có'}</td>
                <td>${p.is_active ? '<span class="tag tag-lifecycle">Hoạt động</span>' : '<span class="tag" style="color:var(--red)">Tắt</span>'}</td>
            </tr>
        `).join('')}</tbody></table>`;
    } catch (err) { console.error(err); }
}

async function loadTagConfig() {
    try {
        const tags = await apiGet('/tag-config');
        const el = document.getElementById('tags-config');
        if (!el) return;

        const groups = {};
        for (const t of tags) {
            if (!groups[t.category]) groups[t.category] = [];
            groups[t.category].push(t);
        }

        const categoryNames = { branch: '🏢 Chi nhánh', staff: '👤 Nhân viên', lifecycle: '📊 Trạng thái KH', service: '📸 Dịch vụ', location: '📍 Địa điểm chụp' };

        el.innerHTML = Object.entries(groups).map(([cat, tags]) => `
            <div style="margin-bottom:12px">
                <div style="font-size:12px;font-weight:600;margin-bottom:4px">${categoryNames[cat] || cat} (${tags.length})</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px">
                    ${tags.map(t => `<span class="tag tag-${t.category}" style="${t.color ? `border-left:3px solid ${t.color}` : ''}">${t.display_name || t.tag_name}</span>`).join('')}
                </div>
            </div>
        `).join('');
    } catch (err) { console.error(err); }
}

async function addPage() {
    const page_id = document.getElementById('new-page-id')?.value;
    const name = document.getElementById('new-page-name')?.value;
    const access_token = document.getElementById('new-page-token')?.value;
    if (!page_id || !name) { toastError('Vui lòng nhập Page ID và tên'); return; }
    try {
        await apiPost('/pages', { page_id, name, access_token });
        toastSuccess('Đã thêm trang!');
        document.getElementById('new-page-id').value = '';
        document.getElementById('new-page-name').value = '';
        document.getElementById('new-page-token').value = '';
        await loadPages();
    } catch (err) { toastError(err.message); }
}

async function saveToken() {
    const token = document.getElementById('master-token-input')?.value?.trim();
    if (!token) { toastError('Vui lòng nhập master token'); return; }
    try {
        await apiPost('/sync/master-token', { token });
        toastSuccess('Đã cập nhật Master Token!');
        document.getElementById('master-token-input').value = '';
        const statusEl = document.getElementById('token-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--green)">✅ Token đã được cấu hình</span>';
    } catch (err) { toastError(err.message); }
}

async function triggerSync(days) {
    const statusEl = document.getElementById('sync-status');
    if (statusEl) statusEl.textContent = `⏳ Đang đồng bộ ${days} ngày...`;
    try {
        await apiPost('/sync/trigger', { days });
        if (statusEl) statusEl.textContent = `✅ Đã kích hoạt đồng bộ ${days} ngày`;
        toastSuccess(`Đã kích hoạt đồng bộ ${days} ngày`);
    } catch (err) {
        if (statusEl) statusEl.textContent = `❌ Lỗi: ${err.message}`;
        toastError(err.message);
    }
}
