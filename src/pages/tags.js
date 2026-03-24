import { apiGet } from '../utils/api.js';
import { fmtNumber, fmtPercent, getDateRange } from '../utils/format.js';
import { renderKpiCard, renderKpiGrid } from '../components/kpiCard.js';

export function destroy() {}

export async function render(container, { tagMap }) {
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = 'Báo cáo Tags';

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) {
        filtersEl.innerHTML = `
            <div class="filter-group">
                <i data-lucide="clock"></i>
                <select class="filter-select" id="tags-time">
                    <option value="this_month">Tháng này</option>
                    <option value="today">Hôm nay</option>
                    <option value="this_week">Tuần này</option>
                    <option value="last_month">Tháng trước</option>
                    <option value="this_quarter">Quý này</option>
                    <option value="this_year">Năm nay</option>
                    <option value="all_time">Tất cả</option>
                </select>
            </div>
        `;
    }

    container.innerHTML = `
        <div id="tags-kpis" class="kpi-grid" style="margin-bottom:12px"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div class="card">
                <div class="chart-title"><i data-lucide="building-2"></i> Chi nhánh (theo tag)</div>
                <div id="branch-tags-table" style="margin-top:8px">Đang tải...</div>
            </div>
            <div class="card">
                <div class="chart-title"><i data-lucide="camera"></i> Dịch vụ (theo tag)</div>
                <div id="service-tags-table" style="margin-top:8px">Đang tải...</div>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="card">
                <div class="chart-title"><i data-lucide="activity"></i> Trạng thái KH (lifecycle)</div>
                <div id="lifecycle-tags-table" style="margin-top:8px">Đang tải...</div>
            </div>
            <div class="card">
                <div class="chart-title"><i data-lucide="map-pin"></i> Địa điểm chụp</div>
                <div id="location-tags-table" style="margin-top:8px">Đang tải...</div>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    const load = () => fetchTagsReport(tagMap);
    document.getElementById('tags-time')?.addEventListener('change', load);
    await load();
}

async function fetchTagsReport(tagMap) {
    const preset = document.getElementById('tags-time')?.value || 'this_month';
    const { from, to } = getDateRange(preset);

    try {
        // Get daily reports with tags_breakdown
        const trendData = await apiGet(`/dashboard/trend?from=${from}&to=${to}`);

        // Get customer KPIs for tag-based counts
        const customerKpis = await apiGet('/dashboard/customer-kpis');

        // Get branch summary
        const branches = await apiGet(`/dashboard/branch-summary?from=${from}&to=${to}`);

        // KPIs
        const kpiEl = document.getElementById('tags-kpis');
        if (kpiEl) {
            const totalCustomers = branches.reduce((s, b) => s + b.total_customers, 0);
            const totalSigned = branches.reduce((s, b) => s + b.signed, 0);
            const totalPhone = branches.reduce((s, b) => s + b.has_phone, 0);

            kpiEl.innerHTML = renderKpiGrid([
                renderKpiCard({ label: 'Tổng KH (có tag CN)', value: fmtNumber(totalCustomers), icon: 'users', color: 'var(--blue)' }),
                renderKpiCard({ label: 'Có SĐT', value: fmtNumber(totalPhone), icon: 'phone', color: 'var(--green)' }),
                renderKpiCard({ label: 'Đã chốt (tag)', value: fmtNumber(totalSigned), icon: 'check-circle', color: '#10B981' }),
                renderKpiCard({ label: 'Chốt (DB)', value: fmtNumber(customerKpis.signed || 0), icon: 'target', color: 'var(--purple)' }),
            ]);
            if (window.lucide) window.lucide.createIcons();
        }

        // Branch table
        renderTagTable('branch-tags-table', branches, [
            { key: 'display_name', label: 'Chi nhánh' },
            { key: 'total_customers', label: 'Khách', align: 'right' },
            { key: 'has_phone', label: 'SĐT', align: 'right' },
            { key: 'potential', label: 'Tiềm năng', align: 'right' },
            { key: 'signed', label: 'Chốt', align: 'right', color: 'var(--green)' },
            { key: 'close_rate', label: 'Tỷ lệ', align: 'right', suffix: '%' },
        ]);

        // Fetch real tag counts from DB
        const tagCounts = await apiGet('/dashboard/tag-counts');

        // Service tags from tagMap with real counts
        const serviceData = getTagCountsByCategory('service', tagMap, tagCounts);
        renderTagTable('service-tags-table', serviceData, [
            { key: 'display_name', label: 'Dịch vụ' },
            { key: 'count', label: 'Khách', align: 'right' },
        ]);

        // Lifecycle tags with real counts
        const lifecycleData = getTagCountsByCategory('lifecycle', tagMap, tagCounts);
        renderTagTable('lifecycle-tags-table', lifecycleData, [
            { key: 'display_name', label: 'Trạng thái' },
            { key: 'count', label: 'Khách', align: 'right' },
        ]);

        // Location tags with real counts
        const locationData = getTagCountsByCategory('location', tagMap, tagCounts);
        renderTagTable('location-tags-table', locationData, [
            { key: 'display_name', label: 'Địa điểm' },
            { key: 'count', label: 'Khách', align: 'right' },
        ]);

    } catch (err) {
        console.error('Lỗi tải báo cáo tags:', err);
    }
}

function getTagCountsByCategory(category, tagMap, tagCounts) {
    return Object.values(tagMap)
        .filter(t => t.category === category)
        .map(t => ({
            ...t,
            count: tagCounts[t.tag_name.toLowerCase()] || 0
        }))
        .sort((a, b) => b.count - a.count);
}

function renderTagTable(containerId, data, columns) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!data || data.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">Chưa có dữ liệu</div>';
        return;
    }
    el.innerHTML = `
        <table class="data-table">
            <thead><tr>${columns.map(c => `<th class="${c.align === 'right' ? 'text-right' : ''}">${c.label}</th>`).join('')}</tr></thead>
            <tbody>${data.map(row => `
                <tr>${columns.map(c => {
                    const val = row[c.key];
                    const style = c.color ? `color:${c.color};font-weight:600` : '';
                    return `<td class="${c.align === 'right' ? 'text-right' : ''}" style="${style}">${val}${c.suffix || ''}</td>`;
                }).join('')}</tr>
            `).join('')}</tbody>
        </table>
    `;
}
