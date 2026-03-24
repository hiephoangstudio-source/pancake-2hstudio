import { apiGet } from '../utils/api.js';
import { fmtNumber, fmtDate } from '../utils/format.js';
import { getBranch } from '../utils/tagClassifier.js';

export function destroy() {}

export async function render(container, { tagMap }) {
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = 'Đơn đã chốt';

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) {
        filtersEl.innerHTML = `
            <div class="filter-group">
                <i data-lucide="search"></i>
                <input type="text" id="order-search" placeholder="Tìm khách, SĐT..." style="border:none;background:transparent;font-size:12px;outline:none;width:160px" />
            </div>
            <div class="filter-group">
                <i data-lucide="file-text"></i>
                <select class="filter-select" id="order-page">
                    <option value="">Tất cả trang</option>
                </select>
            </div>
        `;
    }

    container.innerHTML = `
        <div id="order-kpis" class="kpi-grid" style="margin-bottom:12px"></div>
        <div class="card">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Khách hàng</th>
                        <th>Trang</th>
                        <th>SĐT</th>
                        <th>Chi nhánh</th>
                        <th>Tags</th>
                        <th>Hoạt động cuối</th>
                    </tr>
                </thead>
                <tbody id="order-body">
                    <tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Đang tải...</td></tr>
                </tbody>
            </table>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    try {
        const pages = await apiGet('/pages');
        const sel = document.getElementById('order-page');
        pages.forEach(p => { const opt = document.createElement('option'); opt.value = p.page_id; opt.textContent = p.name; sel?.appendChild(opt); });
    } catch {}

    let debounce;
    const load = () => { clearTimeout(debounce); debounce = setTimeout(() => fetchOrders(tagMap), 300); };
    document.getElementById('order-search')?.addEventListener('input', load);
    document.getElementById('order-page')?.addEventListener('change', () => fetchOrders(tagMap));
    await fetchOrders(tagMap);
}

async function fetchOrders(tagMap) {
    const search = document.getElementById('order-search')?.value || '';
    const pageId = document.getElementById('order-page')?.value || '';

    try {
        // Signed customers = those with "ký" or "chốt" tags
        let url = `/dashboard/customers?tag=${encodeURIComponent('KÝ,KÍ,CHỐT,KH KÝ ONLINE,KH KÍ OFFLINE')}&limit=200`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (pageId) url += `&pageId=${pageId}`;

        const data = await apiGet(url);

        // KPIs
        const kpiEl = document.getElementById('order-kpis');
        if (kpiEl) {
            kpiEl.innerHTML = `
                <div class="kpi-card"><div class="kpi-label"><i data-lucide="check-circle"></i>Tổng đơn chốt</div><div class="kpi-value" style="color:var(--green)">${fmtNumber(data.pagination?.total || 0)}</div></div>
            `;
            if (window.lucide) window.lucide.createIcons();
        }

        const tbody = document.getElementById('order-body');
        if (!tbody) return;

        if (!data.data || data.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Chưa có đơn chốt</td></tr>';
            return;
        }

        // Get page names for lookup
        let pageNameMap = {};
        try { const pgs = await apiGet('/pages'); pgs.forEach(p => { pageNameMap[p.page_id] = p.name; }); } catch {}

        tbody.innerHTML = data.data.map(c => {
            const branchName = getBranch(c.tags, tagMap);
            // phone is VARCHAR containing JSON string like {"captured":"0333...","length":10,...}
            let firstPhone = '';
            if (c.phone) {
                try {
                    const parsed = typeof c.phone === 'string' && c.phone.startsWith('{') ? JSON.parse(c.phone) : c.phone;
                    firstPhone = typeof parsed === 'object' ? (parsed.captured || parsed.phone_number || '') : parsed;
                } catch { firstPhone = c.phone; }
            }
            if (!firstPhone && c.phone_numbers && c.phone_numbers.length > 0) {
                const pn = c.phone_numbers[0];
                firstPhone = typeof pn === 'object' ? (pn.captured || pn.phone_number || '') : pn;
            }
            const pageName = pageNameMap[c.page_id] || c.page_id || '—';
            const tagHtml = (c.tags || []).slice(0, 3).map(t => {
                const name = typeof t === 'string' ? t : (t.name || '');
                const entry = tagMap[name.toLowerCase()];
                return `<span class="tag ${entry ? `tag-${entry.category}` : ''}">${entry?.display_name || name}</span>`;
            }).join(' ');

            return `
                <tr>
                    <td style="font-weight:600">${c.name || '—'}</td>
                    <td style="font-size:12px;color:var(--text-secondary)">${pageName}</td>
                    <td style="font-size:12px">${firstPhone || '—'}</td>
                    <td><span class="tag tag-branch">${branchName}</span></td>
                    <td style="display:flex;gap:4px;flex-wrap:wrap">${tagHtml}</td>
                    <td style="font-size:12px;color:var(--text-secondary)">${fmtDate(c.last_active)}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Lỗi tải đơn chốt:', err);
    }
}
