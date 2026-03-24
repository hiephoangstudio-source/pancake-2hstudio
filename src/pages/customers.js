import { apiGet } from '../utils/api.js';
import { fmtNumber, fmtDate } from '../utils/format.js';
import { classifyTags, getBranch } from '../utils/tagClassifier.js';

export function destroy() {}

export async function render(container, { tagMap }) {
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = 'Khách hàng';

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) {
        filtersEl.innerHTML = `
            <div class="filter-group">
                <i data-lucide="search"></i>
                <input type="text" id="cust-search" placeholder="Tìm tên, SĐT..." style="border:none;background:transparent;font-size:12px;outline:none;width:160px" />
            </div>
            <div class="filter-group">
                <i data-lucide="tag"></i>
                <select class="filter-select" id="cust-tag-filter">
                    <option value="">Tất cả tags</option>
                    <option value="__NEW_TODAY__">Khách mới (30 ngày)</option>
                    <option value="__HAS_PHONE__">Có SĐT</option>
                </select>
            </div>
            <div class="filter-group">
                <i data-lucide="file-text"></i>
                <select class="filter-select" id="cust-page">
                    <option value="">Tất cả trang</option>
                </select>
            </div>
        `;
    }

    container.innerHTML = `
        <div id="cust-segments" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"></div>
        <div class="card">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Khách hàng</th>
                        <th>SĐT</th>
                        <th>Chi nhánh</th>
                        <th>Tags</th>
                        <th class="text-right">Hội thoại</th>
                        <th>Hoạt động cuối</th>
                    </tr>
                </thead>
                <tbody id="cust-body">
                    <tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Đang tải...</td></tr>
                </tbody>
            </table>
            <div id="cust-pagination" style="display:flex;justify-content:center;gap:8px;padding:12px"></div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    try {
        const pages = await apiGet('/pages');
        const sel = document.getElementById('cust-page');
        pages.forEach(p => { const opt = document.createElement('option'); opt.value = p.page_id; opt.textContent = p.name; sel?.appendChild(opt); });
    } catch {}

    let debounce;
    const load = () => { clearTimeout(debounce); debounce = setTimeout(() => fetchCustomers(1, tagMap), 300); };
    document.getElementById('cust-search')?.addEventListener('input', load);
    document.getElementById('cust-tag-filter')?.addEventListener('change', () => fetchCustomers(1, tagMap));
    document.getElementById('cust-page')?.addEventListener('change', () => fetchCustomers(1, tagMap));

    await fetchCustomers(1, tagMap);
}

async function fetchCustomers(page, tagMap) {
    const search = document.getElementById('cust-search')?.value || '';
    const tagFilter = document.getElementById('cust-tag-filter')?.value || '';
    const pageId = document.getElementById('cust-page')?.value || '';

    try {
        let url = `/dashboard/customers?page=${page}&limit=50`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (tagFilter) url += `&tagFilter=${encodeURIComponent(tagFilter)}`;
        if (pageId) url += `&pageId=${pageId}`;

        const data = await apiGet(url);

        // Segments
        const segEl = document.getElementById('cust-segments');
        if (segEl && data.segments) {
            const s = data.segments;
            segEl.innerHTML = [
                { label: 'Mới', count: s.new, color: 'var(--blue)' },
                { label: 'Hoạt động', count: s.active, color: 'var(--green)' },
                { label: 'Trung thành', count: s.loyal, color: '#8B5CF6' },
                { label: 'Có nguy cơ', count: s.at_risk, color: 'var(--orange)' },
                { label: 'Mất', count: s.churned, color: 'var(--red)' },
            ].map(sg => `
                <div class="kpi-card" style="min-width:120px;cursor:pointer">
                    <div class="kpi-label" style="color:${sg.color}">${sg.label}</div>
                    <div class="kpi-value" style="color:${sg.color}">${fmtNumber(sg.count)}</div>
                </div>
            `).join('');
        }

        // Table
        const tbody = document.getElementById('cust-body');
        if (!tbody) return;

        if (!data.data || data.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Không tìm thấy khách hàng</td></tr>';
            return;
        }

        tbody.innerHTML = data.data.map(c => {
            const classified = classifyTags(c.tags, tagMap);
            const branchName = getBranch(c.tags, tagMap);
            const rawPhone = c.phone || '';
            const phoneStr = rawPhone && typeof rawPhone === 'object' ? (rawPhone.captured || '') : rawPhone;
            const pn = c.phone_numbers || [];
            const phone = phoneStr || (pn.length > 0 ? (typeof pn[0] === 'object' ? pn[0].captured || '' : pn[0]) : '');
            const tagHtml = (c.tags || []).slice(0, 4).map(t => {
                const name = typeof t === 'string' ? t : (t.name || '');
                const entry = tagMap[name.toLowerCase()];
                const cls = entry ? `tag-${entry.category}` : '';
                return `<span class="tag ${cls}">${entry?.display_name || name}</span>`;
            }).join(' ');

            return `
                <tr>
                    <td style="font-weight:600">${c.name || '—'}</td>
                    <td style="font-size:12px">${phone || '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td><span class="tag tag-branch">${branchName}</span></td>
                    <td style="display:flex;gap:4px;flex-wrap:wrap">${tagHtml}</td>
                    <td class="text-right">${fmtNumber(c.total_conversations)}</td>
                    <td style="font-size:12px;color:var(--text-secondary)">${fmtDate(c.last_active)}</td>
                </tr>
            `;
        }).join('');

        // Pagination
        const pagEl = document.getElementById('cust-pagination');
        if (pagEl && data.pagination) {
            const p = data.pagination;
            pagEl.innerHTML = `
                <button class="btn btn-sm" ${p.page <= 1 ? 'disabled' : ''} onclick="window.__custPage(${p.page - 1})">← Trước</button>
                <span style="font-size:12px;color:var(--text-muted);padding:4px 8px">Trang ${p.page}/${p.totalPages} (${fmtNumber(p.total)} khách)</span>
                <button class="btn btn-sm" ${p.page >= p.totalPages ? 'disabled' : ''} onclick="window.__custPage(${p.page + 1})">Sau →</button>
            `;
            window.__custPage = (pg) => fetchCustomers(pg, tagMap);
        }
    } catch (err) {
        console.error('Lỗi tải khách hàng:', err);
    }
}
