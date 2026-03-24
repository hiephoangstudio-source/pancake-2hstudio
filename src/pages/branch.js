import { apiGet } from '../utils/api.js';
import { fmtNumber, fmtPercent, getDateRange } from '../utils/format.js';
import { renderKpiCard, renderKpiGrid } from '../components/kpiCard.js';
import { openConversationModal } from '../components/conversationModal.js';

export function destroy() {}

export async function render(container, { branch, tagMap }) {
    const branchName = branch || 'Chưa chọn';
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) headerTitle.textContent = `Chi nhánh ${branchName}`;

    const filtersEl = document.getElementById('header-filters');
    if (filtersEl) {
        filtersEl.innerHTML = `
            <div class="filter-group">
                <i data-lucide="clock"></i>
                <select class="filter-select" id="branch-time">
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
        <div id="branch-kpis" class="kpi-grid">
            ${Array(6).fill('<div class="kpi-card"><div class="skeleton" style="height:14px;width:60px;margin-bottom:8px"></div><div class="skeleton" style="height:28px;width:80px"></div></div>').join('')}
        </div>

        <!-- Row 2: Staff Performance Table -->
        <div class="card" style="margin-top:16px">
            <div class="chart-title"><i data-lucide="users-2"></i> Nhân viên chi nhánh</div>
            <div id="branch-staff-table" style="margin-top:8px;overflow-x:auto">
                <div class="skeleton" style="height:200px"></div>
            </div>
        </div>

        <!-- Row 3: Customer Detail Table -->
        <div class="card" style="margin-top:16px">
            <div class="chart-title"><i data-lucide="contact-2"></i> Chi tiết khách hàng</div>
            <div id="branch-customer-table" style="margin-top:8px;overflow-x:auto">
                <div class="skeleton" style="height:200px"></div>
            </div>
            <div id="branch-cust-pagination" style="display:flex;gap:8px;justify-content:center;margin-top:12px"></div>
        </div>

        <!-- Row 4: Conversion Funnel -->
        <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="card">
                <div class="chart-title"><i data-lucide="activity"></i> Phễu chuyển đổi chi nhánh</div>
                <div id="branch-funnel" style="margin-top:8px">
                    <div class="skeleton" style="height:200px"></div>
                </div>
            </div>
            <div class="card" id="branch-extra-stats">
                <div class="chart-title"><i data-lucide="pie-chart"></i> Tỷ lệ</div>
                <div id="branch-rates" style="margin-top:8px">
                    <div class="skeleton" style="height:200px"></div>
                </div>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    const load = () => fetchBranchData(branch, tagMap);
    document.getElementById('branch-time')?.addEventListener('change', load);
    await load();
}

async function fetchBranchData(branchTag, tagMap) {
    const preset = document.getElementById('branch-time')?.value || 'this_month';
    const { from, to } = getDateRange(preset);

    try {
        // Fetch customers filtered by branch tag
        const customers = await apiGet(`/dashboard/customers?tag=${encodeURIComponent(branchTag)}&limit=200`);
        const totalCustomers = customers.pagination?.total || 0;

        // Count lifecycle stages from customer tags
        let signed = 0, phoneCount = 0, potential = 0, visiting = 0, wrongTarget = 0;
        for (const c of (customers.data || [])) {
            const tags = (c.tags || []).map(t => typeof t === 'string' ? t : t.name || '');
            const tagsStr = tags.join(' ').toLowerCase();
            if (tagsStr.includes('ký') || tagsStr.includes('kí') || tagsStr.includes('chốt')) signed++;
            if (c.phone || (c.phone_numbers && c.phone_numbers.length > 0)) phoneCount++;
            if (tagsStr.includes('tiềm năng')) potential++;
            if (tagsStr.includes('hẹn đến') || tagsStr.includes('đã đến')) visiting++;
            if (tagsStr.includes('sai đối tượng')) wrongTarget++;
        }

        // KPIs
        const kpiEl = document.getElementById('branch-kpis');
        if (kpiEl) {
            const phoneRate = totalCustomers > 0 ? (phoneCount / totalCustomers * 100) : 0;
            const signedRate = totalCustomers > 0 ? (signed / totalCustomers * 100) : 0;
            kpiEl.innerHTML = renderKpiGrid([
                renderKpiCard({ label: 'Tổng khách', value: fmtNumber(totalCustomers), icon: 'users', color: 'var(--blue)' }),
                renderKpiCard({ label: 'Tiềm năng', value: fmtNumber(potential), icon: 'star', color: 'var(--orange)' }),
                renderKpiCard({ label: 'Có SĐT', value: fmtNumber(phoneCount), icon: 'phone', color: 'var(--green)' }),
                renderKpiCard({ label: 'Tỷ lệ SĐT', value: fmtPercent(phoneRate), icon: 'percent', color: 'var(--cyan)' }),
                renderKpiCard({ label: 'Đã chốt', value: fmtNumber(signed), icon: 'check-circle', color: '#10B981' }),
                renderKpiCard({ label: 'Tỷ lệ chốt', value: fmtPercent(signedRate), icon: 'target', color: '#10B981' }),
            ]);
            if (window.lucide) window.lucide.createIcons();
        }

        // ─── Staff Performance Table (full metrics from daily_reports) ───
        const staffEl = document.getElementById('branch-staff-table');
        if (staffEl) {
            try {
                const staffData = await apiGet(`/dashboard/staff?from=${from}&to=${to}`);
                const staffList = staffData.staff || [];

                // Filter staff by branch: match staff who handle customers tagged with this branch
                const branchStaffNames = new Set();
                for (const c of (customers.data || [])) {
                    const tags = (c.tags || []).map(t => typeof t === 'string' ? t : t.name || '');
                    for (const tag of tags) {
                        const match = Object.values(tagMap).find(t => t.category === 'staff' && t.tag_name.toLowerCase() === tag.toLowerCase());
                        if (match) branchStaffNames.add(match.display_name.toLowerCase());
                    }
                }

                // Map staff from daily_reports to their display names
                const filteredStaff = staffList.filter(s => {
                    const name = (s.userName || '').toLowerCase();
                    // If we have branch-tag-based staff, filter by them; otherwise show all
                    if (branchStaffNames.size > 0) {
                        return branchStaffNames.has(name) || Array.from(branchStaffNames).some(n => name.includes(n));
                    }
                    return true;
                });

                const displayStaff = filteredStaff.length > 0 ? filteredStaff : staffList;

                if (displayStaff.length === 0) {
                    staffEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">Chưa có dữ liệu nhân viên</div>';
                } else {
                    // Compute signed, visiting, wrongTarget counts per staff from customer tags
                    const staffTagCounts = {};
                    for (const c of (customers.data || [])) {
                        const tags = (c.tags || []).map(t => typeof t === 'string' ? t : t.name || '');
                        const tagsStr = tags.join(' ').toLowerCase();
                        const isSigned = tagsStr.includes('ký') || tagsStr.includes('kí') || tagsStr.includes('chốt');
                        const isVisiting = tagsStr.includes('hẹn đến') || tagsStr.includes('đã đến');
                        const isWrong = tagsStr.includes('sai đối tượng');
                        // Find which staff owns this customer
                        for (const tag of tags) {
                            const staffMatch = Object.values(tagMap).find(t => t.category === 'staff' && t.tag_name.toLowerCase() === tag.toLowerCase());
                            if (staffMatch) {
                                const key = staffMatch.display_name.toLowerCase();
                                if (!staffTagCounts[key]) staffTagCounts[key] = { signed: 0, visiting: 0, wrong: 0 };
                                if (isSigned) staffTagCounts[key].signed++;
                                if (isVisiting) staffTagCounts[key].visiting++;
                                if (isWrong) staffTagCounts[key].wrong++;
                            }
                        }
                    }

                    staffEl.innerHTML = `<table class="data-table"><thead><tr>
                        <th>Nhân viên</th>
                        <th class="text-right">Hội thoại</th>
                        <th class="text-right">Tin nhắn</th>
                        <th class="text-right">Inbox</th>
                        <th class="text-right">Comment</th>
                        <th class="text-right">Khách hàng</th>
                        <th class="text-right">Hẹn đến</th>
                        <th class="text-right">Có SĐT</th>
                        <th class="text-right">Sai ĐT</th>
                        <th class="text-right">Đã chốt</th>
                        <th class="text-right">Tỷ lệ chốt</th>
                    </tr></thead><tbody>${displayStaff.map(s => {
                        const name = (s.userName || '').toLowerCase();
                        const tc = staffTagCounts[name] || {};
                        const staffSigned = tc.signed || s.signed || 0;
                        const staffVisiting = tc.visiting || 0;
                        const staffWrong = tc.wrong || s.wrongTarget || 0;
                        const rate = s.customers > 0 ? (staffSigned / s.customers * 100) : 0;
                        return `<tr>
                            <td style="font-weight:600">${s.userName || '—'}</td>
                            <td class="text-right">${fmtNumber(s.conversations)}</td>
                            <td class="text-right">${fmtNumber(s.messages)}</td>
                            <td class="text-right">${fmtNumber(s.inbox)}</td>
                            <td class="text-right">${fmtNumber(s.comment)}</td>
                            <td class="text-right">${fmtNumber(s.customers)}</td>
                            <td class="text-right" style="color:var(--purple)">${fmtNumber(staffVisiting)}</td>
                            <td class="text-right" style="color:var(--green)">${fmtNumber(s.phone)}</td>
                            <td class="text-right" style="color:var(--red)">${fmtNumber(staffWrong)}</td>
                            <td class="text-right" style="color:var(--green);font-weight:600">${fmtNumber(staffSigned)}</td>
                            <td class="text-right" style="color:${rate > 10 ? 'var(--green)' : 'var(--orange)'}">${fmtPercent(rate)}</td>
                        </tr>`;
                    }).join('')}
                    <tr style="font-weight:700;border-top:2px solid var(--border)">
                        <td>Tổng</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.conversations, 0))}</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.messages, 0))}</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.inbox, 0))}</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.comment, 0))}</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.customers, 0))}</td>
                        <td class="text-right">${fmtNumber(visiting)}</td>
                        <td class="text-right">${fmtNumber(displayStaff.reduce((a,s) => a+s.phone, 0))}</td>
                        <td class="text-right">${fmtNumber(wrongTarget)}</td>
                        <td class="text-right">${fmtNumber(signed)}</td>
                        <td class="text-right">—</td>
                    </tr>
                    </tbody></table>`;
                }
            } catch (err) {
                console.error('Staff data error:', err);
                staffEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">Không thể tải dữ liệu nhân viên</div>';
            }
        }

        // ─── Customer Detail Table ───
        const custEl = document.getElementById('branch-customer-table');
        if (custEl) {
            const custData = customers.data || [];
            if (custData.length === 0) {
                custEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">Chưa có khách hàng</div>';
            } else {
                custEl.innerHTML = `<table class="data-table"><thead><tr>
                    <th>Khách hàng</th>
                    <th>SĐT</th>
                    <th>Tags</th>
                    <th class="text-right">Hội thoại</th>
                    <th>Hoạt động cuối</th>
                </tr></thead><tbody>${custData.map(c => {
                    // Extract phone
                    let phone = '';
                    if (c.phone) {
                        try {
                            const parsed = typeof c.phone === 'string' && c.phone.startsWith('{') ? JSON.parse(c.phone) : c.phone;
                            phone = typeof parsed === 'object' ? (parsed.captured || parsed.phone_number || '') : parsed;
                        } catch { phone = c.phone; }
                    }
                    if (!phone && c.phone_numbers && c.phone_numbers.length > 0) {
                        const pn = c.phone_numbers[0];
                        phone = typeof pn === 'object' ? (pn.captured || pn.phone_number || '') : pn;
                    }

                    const tagHtml = (c.tags || []).slice(0, 4).map(t => {
                        const name = typeof t === 'string' ? t : (t.name || '');
                        const entry = tagMap[name.toLowerCase()];
                        const cls = entry ? `tag-${entry.category}` : '';
                        return `<span class="tag ${cls}">${entry?.display_name || name}</span>`;
                    }).join(' ');

                    const fmtDate = (d) => { if (!d) return '—'; const dt = new Date(d); return `${dt.getDate()}/${dt.getMonth()+1}/${dt.getFullYear()}`; };

                    return `<tr class="clickable" data-customer-id="${c.pancake_id}" data-customer-name="${c.name || ''}">
                        <td style="font-weight:600">${c.name || '—'}</td>
                        <td style="font-size:12px">${phone || '<span style="color:var(--text-muted)">—</span>'}</td>
                        <td style="display:flex;gap:4px;flex-wrap:wrap">${tagHtml}</td>
                        <td class="text-right">${fmtNumber(c.total_conversations)}</td>
                        <td style="font-size:12px;color:var(--text-secondary)">${fmtDate(c.last_active)}</td>
                    </tr>`;
                }).join('')}</tbody></table>`;

                // Attach click handlers for conversation modal
                custEl.querySelectorAll('tr.clickable').forEach(row => {
                    row.addEventListener('click', () => {
                        openConversationModal({
                            pancake_id: row.dataset.customerId,
                            name: row.dataset.customerName
                        });
                    });
                });
            }
        }

        // Funnel
        const funnelEl = document.getElementById('branch-funnel');
        if (funnelEl) {
            const steps = [
                { label: 'Tổng khách', value: totalCustomers, color: 'var(--blue)' },
                { label: 'Tiềm năng', value: potential, color: 'var(--orange)' },
                { label: 'Hẹn đến', value: visiting, color: '#8B5CF6' },
                { label: 'Có SĐT', value: phoneCount, color: 'var(--cyan)' },
                { label: 'Đã chốt', value: signed, color: 'var(--green)' },
            ];
            const maxVal = Math.max(totalCustomers, 1);
            funnelEl.innerHTML = `<div class="funnel">${steps.map(s => `
                <div class="funnel-step">
                    <div class="funnel-label">${s.label}</div>
                    <div class="funnel-bar-wrapper">
                        <div class="funnel-bar" style="width:${Math.max((s.value / maxVal * 100), 3)}%;background:${s.color}">${fmtNumber(s.value)}</div>
                    </div>
                    <div class="funnel-count">${totalCustomers > 0 ? fmtPercent(s.value / totalCustomers * 100) : ''}</div>
                </div>
            `).join('')}</div>`;
        }

        // Rates card
        const ratesEl = document.getElementById('branch-rates');
        if (ratesEl) {
            const phoneRate = totalCustomers > 0 ? (phoneCount / totalCustomers * 100) : 0;
            const signedRate = totalCustomers > 0 ? (signed / totalCustomers * 100) : 0;
            const wrongRate = totalCustomers > 0 ? (wrongTarget / totalCustomers * 100) : 0;
            ratesEl.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:12px">
                    ${[
                        { label: 'Tỷ lệ có SĐT', value: phoneRate, color: 'var(--green)' },
                        { label: 'Tỷ lệ chốt', value: signedRate, color: 'var(--blue)' },
                        { label: 'Tỷ lệ sai ĐT', value: wrongRate, color: 'var(--red)' },
                    ].map(r => `
                        <div>
                            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                                <span>${r.label}</span>
                                <span style="font-weight:600;color:${r.color}">${fmtPercent(r.value)}</span>
                            </div>
                            <div style="height:8px;background:var(--border-light);border-radius:4px;overflow:hidden">
                                <div style="height:100%;width:${Math.min(r.value, 100)}%;background:${r.color};border-radius:4px;transition:width 0.5s"></div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    } catch (err) {
        console.error('Lỗi tải chi nhánh:', err);
    }
}
