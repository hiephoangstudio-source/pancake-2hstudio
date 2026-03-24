import { apiGet } from '../utils/api.js';
import { fmtNumber, fmtMoney, fmtPercent, getDateRange } from '../utils/format.js';
import { renderKpiCard, renderKpiGrid } from '../components/kpiCard.js';

let charts = {};
export function destroy() { Object.values(charts).forEach(c => c.destroy()); charts = {}; }

export async function render(container, { tagMap }) {
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = 'Hiệu quả kênh quảng cáo';

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) {
        filtersEl.innerHTML = `
            <div class="filter-group">
                <i data-lucide="clock"></i>
                <select class="filter-select" id="ch-time">
                    <option value="this_month">Tháng này</option>
                    <option value="last_month">Tháng trước</option>
                    <option value="this_quarter">Quý này</option>
                    <option value="this_year">Năm nay</option>
                    <option value="all_time">Tất cả</option>
                </select>
            </div>
            <div class="filter-group">
                <i data-lucide="file-text"></i>
                <select class="filter-select" id="ch-page">
                    <option value="">Tất cả trang</option>
                </select>
            </div>
        `;
    }

    container.innerHTML = `
        <div id="ch-kpis" class="kpi-grid" style="margin-bottom:12px"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div class="card">
                <div class="chart-title"><i data-lucide="megaphone"></i> Phễu quảng cáo</div>
                <div id="ads-funnel" style="margin-top:8px"></div>
            </div>
            <div class="card">
                <div class="chart-title"><i data-lucide="bar-chart-3"></i> So sánh Pages (chi phí)</div>
                <div style="height:260px"><canvas id="page-spend-chart"></canvas></div>
            </div>
        </div>
        <div class="card">
            <div class="chart-title"><i data-lucide="list"></i> Danh sách chiến dịch QC</div>
            <table class="data-table" id="campaigns-table">
                <thead>
                    <tr>
                        <th>Tên chiến dịch</th>
                        <th>Trang</th>
                        <th class="text-right">Chi phí</th>
                        <th class="text-right">Hiển thị</th>
                        <th class="text-right">Click</th>
                        <th class="text-right">Hội thoại</th>
                        <th class="text-right">SĐT</th>
                        <th class="text-right">Chi phí/SĐT</th>
                        <th class="text-center">Trạng thái</th>
                    </tr>
                </thead>
                <tbody id="campaigns-body">
                    <tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">Đang tải...</td></tr>
                </tbody>
            </table>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    try {
        const pages = await apiGet('/pages');
        const sel = document.getElementById('ch-page');
        pages.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.page_id;
            opt.textContent = p.name;
            sel?.appendChild(opt);
        });
    } catch {}

    const load = () => fetchChannels();
    document.getElementById('ch-time')?.addEventListener('change', load);
    document.getElementById('ch-page')?.addEventListener('change', load);
    await load();
}

async function fetchChannels() {
    const preset = document.getElementById('ch-time')?.value || 'this_month';
    const pageId = document.getElementById('ch-page')?.value || '';
    const { from, to } = getDateRange(preset);

    try {
        let url = `/channels?from=${from}&to=${to}`;
        if (pageId) url += `&pageId=${pageId}`;
        const data = await apiGet(url);
        const channels = Array.isArray(data) ? data : (data.data || data.channels || []);

        // Aggregate
        let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalConv = 0, totalPhones = 0;
        for (const ch of channels) {
            totalSpend += Number(ch.spend || 0);
            totalImpressions += Number(ch.impressions || 0);
            totalClicks += Number(ch.clicks || 0);
            totalConv += Number(ch.conversations || 0);
            totalPhones += Number(ch.phones || 0);
        }

        const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
        const cpl = totalPhones > 0 ? totalSpend / totalPhones : 0;
        const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0;

        // KPIs
        const kpiEl = document.getElementById('ch-kpis');
        if (kpiEl) {
            kpiEl.innerHTML = renderKpiGrid([
                renderKpiCard({ label: 'Tổng chi QC', value: fmtMoney(totalSpend), icon: 'wallet', color: 'var(--blue)' }),
                renderKpiCard({ label: 'Hiển thị', value: fmtNumber(totalImpressions), icon: 'eye', color: '#8B5CF6' }),
                renderKpiCard({ label: 'Click', value: fmtNumber(totalClicks), icon: 'mouse-pointer', color: 'var(--orange)' }),
                renderKpiCard({ label: 'CTR', value: fmtPercent(ctr), icon: 'percent', color: 'var(--cyan)' }),
                renderKpiCard({ label: 'Hội thoại', value: fmtNumber(totalConv), icon: 'message-circle', color: 'var(--blue)' }),
                renderKpiCard({ label: 'SĐT', value: fmtNumber(totalPhones), icon: 'phone', color: 'var(--green)' }),
                renderKpiCard({ label: 'CPC', value: fmtMoney(cpc), icon: 'coins', color: 'var(--orange)' }),
                renderKpiCard({ label: 'Chi phí/SĐT', value: fmtMoney(cpl), icon: 'target', color: 'var(--red)' }),
            ]);
            if (window.lucide) window.lucide.createIcons();
        }

        // Funnel
        const funnelEl = document.getElementById('ads-funnel');
        if (funnelEl) {
            const steps = [
                { label: 'Hiển thị', value: totalImpressions, color: '#8B5CF6' },
                { label: 'Click', value: totalClicks, color: 'var(--orange)' },
                { label: 'Hội thoại', value: totalConv, color: 'var(--blue)' },
                { label: 'Có SĐT', value: totalPhones, color: 'var(--green)' },
            ];
            const maxVal = Math.max(totalImpressions, 1);
            funnelEl.innerHTML = `<div class="funnel">${steps.map(s => `
                <div class="funnel-step">
                    <div class="funnel-label">${s.label}</div>
                    <div class="funnel-bar-wrapper">
                        <div class="funnel-bar" style="width:${Math.max((s.value / maxVal * 100), 2)}%;background:${s.color}">${fmtNumber(s.value)}</div>
                    </div>
                    <div class="funnel-count">${totalImpressions > 0 ? fmtPercent(s.value / totalImpressions * 100) : ''}</div>
                </div>
            `).join('')}</div>`;
        }

        // Campaigns table
        const tbody = document.getElementById('campaigns-body');
        if (tbody) {
            if (channels.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">Chưa có dữ liệu quảng cáo</td></tr>';
            } else {
                tbody.innerHTML = channels
                    .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
                    .map(ch => {
                        const costPerPhone = Number(ch.phones) > 0 ? Number(ch.spend) / Number(ch.phones) : 0;
                        const statusColor = ch.status === 'ACTIVE' ? 'var(--green)' : 'var(--text-muted)';
                        return `
                        <tr>
                            <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ch.name || ch.ad_id}</td>
                            <td style="font-size:12px;color:var(--text-secondary)">${ch.pageName || ch.page_id || '—'}</td>
                            <td class="text-right" style="font-weight:600">${fmtMoney(ch.spend)}</td>
                            <td class="text-right">${fmtNumber(ch.impressions)}</td>
                            <td class="text-right">${fmtNumber(ch.clicks)}</td>
                            <td class="text-right">${fmtNumber(ch.conversations)}</td>
                            <td class="text-right">${fmtNumber(ch.phones)}</td>
                            <td class="text-right" style="color:${costPerPhone > 500000 ? 'var(--red)' : 'var(--green)'}; font-weight:600">${costPerPhone > 0 ? fmtMoney(costPerPhone) : '—'}</td>
                            <td class="text-center"><span class="tag" style="color:${statusColor}">${ch.status || '—'}</span></td>
                        </tr>`;
                    }).join('');
            }
        }
    } catch (err) {
        console.error('Lỗi tải kênh QC:', err);
    }
}
