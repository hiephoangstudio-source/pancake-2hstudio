const MENU = [
    { section: 'TỔNG QUAN' },
    { id: 'dashboard', label: 'Tổng quan', icon: 'layout-dashboard', href: '/' },
    { section: 'CHI NHÁNH' },
    { id: 'branch-hoang-cau', label: 'Hoàng Cầu', icon: 'building-2', href: '/?page=branch&branch=HOÀNG CẦU', branchTag: 'HOÀNG CẦU' },
    { id: 'branch-sai-gon', label: 'Sài Gòn', icon: 'building-2', href: '/?page=branch&branch=Sài Gòn', branchTag: 'Sài Gòn' },
    { id: 'branch-son-tay', label: 'Sơn Tây', icon: 'building-2', href: '/?page=branch&branch=SƠN TÂY', branchTag: 'SƠN TÂY' },
    { id: 'branch-ninh-hiep', label: 'Ninh Hiệp', icon: 'building-2', href: '/?page=branch&branch=NINH HIỆP', branchTag: 'NINH HIỆP' },
    { id: 'branch-long-bien', label: 'Long Biên', icon: 'building-2', href: '/?page=branch&branch=Long biên', branchTag: 'Long biên' },
    { section: 'PHÂN TÍCH' },
    { id: 'staff', label: 'Nhân viên', icon: 'user-check', href: '/?page=staff' },
    { id: 'channels', label: 'Hiệu quả kênh QC', icon: 'megaphone', href: '/?page=channels' },
    { id: 'customers', label: 'Khách hàng', icon: 'users', href: '/?page=customers' },
    { id: 'orders', label: 'Đơn đã chốt', icon: 'shopping-cart', href: '/?page=orders' },
    { id: 'tags', label: 'Báo cáo Tags', icon: 'tag', href: '/?page=tags' },
    { section: 'HỆ THỐNG' },
    { id: 'settings', label: 'Cấu hình', icon: 'settings', href: '/?page=settings' },
];

export function renderSidebar(container, activePage) {
    let html = `
        <div class="sidebar-brand">
            <img src="/logo.png" alt="2H Studio" onerror="this.style.display='none'" />
            <span>2H Studio</span>
        </div>
        <nav class="sidebar-nav">
    `;

    for (const item of MENU) {
        if (item.section) {
            html += `<div class="sidebar-section">${item.section}</div>`;
            continue;
        }
        const isActive = activePage === item.id;
        html += `
            <a class="sidebar-link ${isActive ? 'active' : ''}"
               href="${item.href}"
               data-page="${item.id}"
               ${item.branchTag ? `data-branch="${item.branchTag}"` : ''}>
                <i data-lucide="${item.icon}"></i>
                <span>${item.label}</span>
            </a>
        `;
    }

    html += `
        </nav>
        <div class="sidebar-footer">
            <div style="display:flex;align-items:center;gap:4px">
                <i data-lucide="clock" style="width:12px;height:12px"></i>
                <span id="last-sync-time">—</span>
            </div>
        </div>
    `;

    container.innerHTML = html;

    // SPA navigation
    container.querySelectorAll('.sidebar-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            window.history.pushState({}, '', href);
            window.dispatchEvent(new PopStateEvent('popstate'));
            closeSidebarMobile();
        });
    });

    // Re-render lucide icons
    if (window.lucide) window.lucide.createIcons();

    // Overlay click → close sidebar
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) overlay.addEventListener('click', closeSidebarMobile);
}

export function updateSyncTime(timeStr) {
    const el = document.getElementById('last-sync-time');
    if (el) el.textContent = timeStr || '—';
}

export function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar) return;

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        sidebar.classList.toggle('open');
        overlay?.classList.toggle('active', sidebar.classList.contains('open'));
    } else {
        sidebar.classList.toggle('collapsed');
    }
}

function closeSidebarMobile() {
    if (window.innerWidth > 768) return;
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar?.classList.remove('open');
    overlay?.classList.remove('active');
}
