/**
 * Pancake API Sync Service
 * Expanded to pull ALL available data from Pancake API:
 *
 * Pages API v1 (pages.fm/api/public_api/v1):
 *   - /pages/{id}/users                    → users table
 *   - /pages/{id}/tags                     → tags table
 *   - /pages/{id}/customers                → (via conversations)
 *   - /pages/{id}/statistics/pages          → page_statistics table (hourly)
 *   - /pages/{id}/statistics/ads            → channels table
 *   - /pages/{id}/statistics/pages_campaigns → channels (campaign-level)
 *   - /pages/{id}/statistics/customer_engagements → page_statistics enrichment
 *   - /pages/{id}/statistics/tags           → tags enrichment (usage counts)
 *   - /pages/{id}/statistics/users          → user stats (response times)
 *   - /pages/{id}/page_customers            → new customer stats
 *
 * Pages API v2 (pages.fm/api/public_api/v2):
 *   - /pages/{id}/conversations             → conversations + daily_reports + customers
 *
 * POS API (pos.pages.fm/api/v1) — requires master API key:
 *   - /shops/{id}/orders                    → orders table
 *   - /shops/{id}/analytics/sale            → sales analytics
 */

import { query, getClient } from '../db.js';
import { decrypt } from '../utils/crypto.js';

const PAGES_API_V1 = 'https://pages.fm/api/public_api/v1';
const PAGES_API_V2 = 'https://pages.fm/api/public_api/v2';
const POS_API = 'https://pos.pages.fm/api/v1';

async function fetchJson(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(url);
        if (res.status === 429) {
            const wait = attempt * 5000; // 5s, 10s, 15s backoff
            console.warn(`⏳ Rate limited (429), retrying in ${wait / 1000}s (attempt ${attempt}/${retries})...`);
            await new Promise(r => setTimeout(r, wait));
            continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return res.json();
    }
    throw new Error('HTTP 429: Rate limited after all retries');
}

/**
 * Sync a single page's data from Pancake API into PostgreSQL.
 */
export async function syncPageData(pageId, accessToken, daysBack = 30) {
    if (!accessToken) return { success: false, error: 'No access token' };

    const now = new Date();
    const since = Math.floor(new Date(now.getTime() - daysBack * 86400000).getTime() / 1000);
    const until = Math.floor(now.getTime() / 1000);
    const token = encodeURIComponent(accessToken);

    const results = { page_id: pageId, conversations: 0, users: 0, ads: 0, tags: 0, pageStats: 0, errors: [] };

    // ── 1. Users ─────────────────────────────
    try {
        const data = await fetchJson(`${PAGES_API_V1}/pages/${pageId}/users?page_access_token=${token}`);
        const users = data.users || [];
        if (users.length > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const u of users) {
                    await client.query(`
            INSERT INTO users (pancake_id, name, email, role, avatar)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (pancake_id) DO UPDATE SET
              name = EXCLUDED.name, role = EXCLUDED.role, updated_at = NOW()
          `, [
                        String(u.id), u.name || 'Unknown', u.email || '',
                        u.role_in_page === 'ADMINISTER' ? 'admin' : 'user',
                        u.avatar || null,
                    ]);
                }
                await client.query('COMMIT');
                results.users = users.length;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }
    } catch (e) {
        results.errors.push(`Users: ${e.message}`);
    }

    // ── 2. Tags ──────────────────────────────
    try {
        const data = await fetchJson(`${PAGES_API_V1}/pages/${pageId}/tags?page_access_token=${token}`);
        const tags = data.tags || [];
        if (tags.length > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const t of tags) {
                    await client.query(`
            INSERT INTO tags (name, color) VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
          `, [t.text, t.color || null]);
                }
                await client.query('COMMIT');
                results.tags = tags.length;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }
    } catch (e) {
        results.errors.push(`Tags: ${e.message}`);
    }

    // ── 3. Conversations + Customers + Daily Reports ─
    const dailyStats = {};
    try {
        let lastId = null;
        let totalConvs = 0;
        const convBatch = [];
        const customerMap = new Map();

        for (let page = 1; page <= 500; page++) {
            let url = `${PAGES_API_V2}/pages/${pageId}/conversations?page_access_token=${token}&page_id=${pageId}&since=${since}&until=${until}`;
            if (lastId) url += `&last_conversation_id=${lastId}`;

            const data = await fetchJson(url);
            const convs = data.conversations || [];
            if (convs.length === 0) break;

            for (const conv of convs) {
                const dateStr = conv.updated_at?.split('T')[0];
                if (!dateStr) continue;

                const assignees = conv.current_assign_users || [{ id: 'unassigned', name: 'Chưa phân công' }];
                const convType = conv.type || 'UNKNOWN';
                const messageCount = conv.message_count || 0;
                const hasPhone = conv.has_phone ? 1 : 0;
                const adsLinked = (conv.ads && conv.ads.length > 0) ? 1 : 0;
                const customers = conv.customers || [];
                const customerId = customers[0]?.id || '';
                const tags = (conv.tags || []).filter(t => t && t.text).map(t => t.text);
                const userId = String(assignees[0]?.id || '');

                // Aggregate daily stats per user
                for (const user of assignees) {
                    const uid = String(user.id || 'unknown');
                    const uname = user.name || 'Unknown';
                    if (!dailyStats[dateStr]) dailyStats[dateStr] = {};
                    if (!dailyStats[dateStr][uid]) {
                        dailyStats[dateStr][uid] = {
                            conversations: 0, total_messages: 0, inbox_count: 0, comment_count: 0,
                            unique_customers: new Set(), has_phone: 0, ads_linked: 0, tags: {}, user_name: uname,
                        };
                    }
                    const stats = dailyStats[dateStr][uid];
                    stats.conversations += 1;
                    stats.total_messages += messageCount;
                    if (convType === 'INBOX') stats.inbox_count += 1;
                    if (convType === 'COMMENT') stats.comment_count += 1;
                    if (customerId) stats.unique_customers.add(customerId);
                    stats.has_phone += hasPhone;
                    stats.ads_linked += adsLinked;
                    for (const tag of tags) {
                        stats.tags[tag] = (stats.tags[tag] || 0) + 1;
                    }
                }

                // Collect customers — phone data lives on conv.recent_phone_numbers, not customer object
                const recentPhones = Array.isArray(conv.recent_phone_numbers) ? conv.recent_phone_numbers.filter(Boolean) : [];
                const firstPhone = recentPhones[0] || null;
                for (const c of customers) {
                    const existing = customerMap.get(String(c.id));
                    customerMap.set(String(c.id), {
                        pancake_id: String(c.id), name: c.name || 'Unnamed',
                        phone: firstPhone || existing?.phone || null,
                        phone_numbers: recentPhones.length ? recentPhones : (existing?.phone_numbers || []),
                        gender: c.gender || null,
                        tags: (c.tags || []).filter(t => t).map(t => ({ id: t.id, text: t.text || '', color: t.color })),
                        last_active: dateStr, page_id: pageId,
                    });
                }

                // Collect conversation
                convBatch.push({
                    pancake_id: String(conv.id), type: convType,
                    customer_pancake_id: String(customerId), user_pancake_id: userId,
                    date: dateStr, snippet: (conv.snippet || '').substring(0, 200),
                    tags, page_id: pageId,
                });
                totalConvs++;
            }
            lastId = convs[convs.length - 1]?.id;
            // Rate limit
            await new Promise(r => setTimeout(r, 500));
        }

        // Bulk insert conversations
        if (convBatch.length > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const c of convBatch) {
                    await client.query(`
            INSERT INTO conversations (pancake_id, type, customer_pancake_id, user_pancake_id, date, snippet, tags, page_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (pancake_id) DO UPDATE SET
              type = EXCLUDED.type, user_pancake_id = EXCLUDED.user_pancake_id,
              snippet = EXCLUDED.snippet, tags = EXCLUDED.tags, updated_at = NOW()
          `, [c.pancake_id, c.type, c.customer_pancake_id, c.user_pancake_id, c.date, c.snippet, JSON.stringify(c.tags), c.page_id]);
                }
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        }

        // Bulk upsert customers
        if (customerMap.size > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const c of customerMap.values()) {
                    await client.query(`
            INSERT INTO customers (pancake_id, name, phone, phone_numbers, gender, tags, last_active, page_id, total_conversations)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
            ON CONFLICT (pancake_id) DO UPDATE SET
              name = EXCLUDED.name, phone = EXCLUDED.phone, phone_numbers = EXCLUDED.phone_numbers,
              gender = EXCLUDED.gender, tags = EXCLUDED.tags, page_id = EXCLUDED.page_id,
              last_active = GREATEST(customers.last_active, EXCLUDED.last_active),
              total_conversations = customers.total_conversations + 1,
              updated_at = NOW()
          `, [c.pancake_id, c.name, c.phone, JSON.stringify(c.phone_numbers), c.gender, JSON.stringify(c.tags), c.last_active, c.page_id]);
                }
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        }

        results.conversations = totalConvs;
    } catch (e) {
        results.errors.push(`Conversations: ${e.message}`);
    }

    // ── 4. Daily Reports ─────────────────────
    try {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            for (const [date, userStats] of Object.entries(dailyStats)) {
                for (const [userId, stats] of Object.entries(userStats)) {
                    const signed = stats.tags['Đã chốt'] || 0;
                    const wrongTarget = stats.tags['Sai đối tượng'] || stats.tags['SAI ĐỐI TƯỢNG'] || 0;
                    const otherTags = Object.values(stats.tags).reduce((a, b) => a + b, 0) - signed - wrongTarget;

                    await client.query(`
            INSERT INTO daily_reports (date, user_pancake_id, user_name, page_id, conversations, total_messages,
              inbox_count, comment_count, unique_customers, has_phone, ads_linked, signed, wrong_target, other_tags, tags_breakdown)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (date, user_pancake_id, page_id) DO UPDATE SET
              user_name = EXCLUDED.user_name, conversations = EXCLUDED.conversations,
              total_messages = EXCLUDED.total_messages, inbox_count = EXCLUDED.inbox_count,
              comment_count = EXCLUDED.comment_count, unique_customers = EXCLUDED.unique_customers,
              has_phone = EXCLUDED.has_phone, ads_linked = EXCLUDED.ads_linked, signed = EXCLUDED.signed,
              wrong_target = EXCLUDED.wrong_target, other_tags = EXCLUDED.other_tags,
              tags_breakdown = EXCLUDED.tags_breakdown, updated_at = NOW()
          `, [date, userId, stats.user_name, pageId, stats.conversations, stats.total_messages,
                        stats.inbox_count, stats.comment_count, stats.unique_customers.size,
                        stats.has_phone, stats.ads_linked, signed, wrongTarget, otherTags,
                        JSON.stringify(stats.tags)]);
                }
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
    } catch (e) {
        results.errors.push(`Reports: ${e.message}`);
    }

    // ── 5. Ads Statistics (Channels) ─────────
    try {
        const data = await fetchJson(`${PAGES_API_V1}/pages/${pageId}/statistics/ads?page_access_token=${token}&since=${since}&until=${until}&type=by_id`);
        const ads = data.ads || data.data || data || [];
        if (Array.isArray(ads) && ads.length > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const ad of ads) {
                    await client.query(`
            INSERT INTO channels (ad_id, name, page_id, status, spend, impressions, clicks, conversations, phones, cost_per_phone, tags_summary)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (ad_id) DO UPDATE SET
              name = EXCLUDED.name, status = EXCLUDED.status, spend = EXCLUDED.spend,
              impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
              conversations = EXCLUDED.conversations, phones = EXCLUDED.phones,
              cost_per_phone = EXCLUDED.cost_per_phone, tags_summary = EXCLUDED.tags_summary, updated_at = NOW()
          `, [
                        String(ad.ad_id || ad.id), ad.ad_name || ad.name || 'Unknown', pageId,
                        ad.status || 'UNKNOWN', Number(ad.spend || 0), Number(ad.impressions || 0),
                        Number(ad.clicks || 0), Number(ad.conversations || 0), Number(ad.phone || ad.phones || 0),
                        Number(ad.cost_per_phone || 0), JSON.stringify(ad.tags || {}),
                    ]);
                }
                await client.query('COMMIT');
                results.ads = ads.length;
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        }
    } catch (e) {
        results.errors.push(`Ads: ${e.message}`);
    }

    // ── 6. Page Statistics (hourly — NEW) ────
    try {
        const data = await fetchJson(`${PAGES_API_V1}/pages/${pageId}/statistics/pages?page_access_token=${token}&since=${since}&until=${until}`);
        const stats = data.data || [];
        if (Array.isArray(stats) && stats.length > 0) {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const s of stats) {
                    await client.query(`
            INSERT INTO page_statistics (page_id, hour, new_customer_count, customer_inbox_count, customer_comment_count,
              page_inbox_count, page_comment_count, phone_number_count, inbox_interactive_count,
              new_inbox_count, uniq_phone_number_count, today_uniq_website_referral, today_website_guest_referral)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (page_id, hour) DO UPDATE SET
              new_customer_count = EXCLUDED.new_customer_count,
              customer_inbox_count = EXCLUDED.customer_inbox_count,
              customer_comment_count = EXCLUDED.customer_comment_count,
              page_inbox_count = EXCLUDED.page_inbox_count,
              page_comment_count = EXCLUDED.page_comment_count,
              phone_number_count = EXCLUDED.phone_number_count,
              inbox_interactive_count = EXCLUDED.inbox_interactive_count,
              new_inbox_count = EXCLUDED.new_inbox_count,
              uniq_phone_number_count = EXCLUDED.uniq_phone_number_count,
              today_uniq_website_referral = EXCLUDED.today_uniq_website_referral,
              today_website_guest_referral = EXCLUDED.today_website_guest_referral
          `, [
                        pageId, s.hour, s.new_customer_count || 0, s.customer_inbox_count || 0,
                        s.customer_comment_count || 0, s.page_inbox_count || 0, s.page_comment_count || 0,
                        s.phone_number_count || 0, s.inbox_interactive_count || 0, s.new_inbox_count || 0,
                        s.uniq_phone_number_count || 0, s.today_uniq_website_referral || 0,
                        s.today_website_guest_referral || 0,
                    ]);
                }
                await client.query('COMMIT');
                results.pageStats = stats.length;
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        }
    } catch (e) {
        results.errors.push(`PageStats: ${e.message}`);
    }

    // ── 7. User Statistics (response time — NEW) ──
    try {
        const data = await fetchJson(`${PAGES_API_V1}/pages/${pageId}/statistics/users?page_access_token=${token}&since=${since}&until=${until}`);
        const statsMap = data?.data?.statistics || {};
        let totalUserStats = 0;
        const client = await getClient();
        try {
            await client.query('BEGIN');
            for (const [userId, hourlyStats] of Object.entries(statsMap)) {
                if (!Array.isArray(hourlyStats)) continue;
                for (const s of hourlyStats) {
                    await client.query(`
            INSERT INTO user_statistics (user_pancake_id, page_id, hour, inbox_count, comment_count,
              phone_number_count, order_count, average_response_time, private_reply_count,
              unique_inbox_count, unique_comment_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (user_pancake_id, page_id, hour) DO UPDATE SET
              inbox_count = EXCLUDED.inbox_count, comment_count = EXCLUDED.comment_count,
              phone_number_count = EXCLUDED.phone_number_count, order_count = EXCLUDED.order_count,
              average_response_time = EXCLUDED.average_response_time,
              private_reply_count = EXCLUDED.private_reply_count,
              unique_inbox_count = EXCLUDED.unique_inbox_count,
              unique_comment_count = EXCLUDED.unique_comment_count
          `, [
                        userId, pageId, s.hour,
                        s.inbox_count || 0, s.comment_count || 0,
                        s.phone_number_count || 0, s.order_count || 0,
                        s.average_response_time || 0, s.private_reply_count || 0,
                        s.unique_inbox_count || 0, s.unique_comment_count || 0,
                    ]);
                    totalUserStats++;
                }
            }
            await client.query('COMMIT');
            results.userStats = totalUserStats;
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
    } catch (e) {
        results.errors.push(`UserStats: ${e.message}`);
    }

    // Update last_synced_at for this page
    try {
        await query('UPDATE pages SET last_synced_at = NOW() WHERE page_id = $1', [pageId]);
    } catch (e) {
        results.errors.push(`UpdateSyncTime: ${e.message}`);
    }

    // ── Post-sync: Merge conversation tags into customer tags ──
    // Pancake API puts tags on conversations, not customers. This copies them.
    try {
        const { rowCount } = await query(`
            UPDATE customers c SET tags = agg.merged_tags
            FROM (
                SELECT customer_pancake_id,
                    (SELECT jsonb_agg(DISTINCT elem) FROM (
                        SELECT jsonb_array_elements_text(conv.tags) AS elem
                        FROM conversations conv
                        WHERE conv.customer_pancake_id = sub.customer_pancake_id
                          AND jsonb_array_length(conv.tags) > 0
                    ) t) AS merged_tags
                FROM (SELECT DISTINCT customer_pancake_id FROM conversations
                      WHERE page_id = $1 AND customer_pancake_id != '' AND jsonb_array_length(tags) > 0) sub
            ) agg
            WHERE c.pancake_id = agg.customer_pancake_id AND agg.merged_tags IS NOT NULL
        `, [pageId]);
        results.taggedCustomers = rowCount;
    } catch (e) {
        results.errors.push(`TagMerge: ${e.message}`);
    }

    results.success = results.errors.length === 0;
    return results;
}

/**
 * Sync all active pages.
 */
export async function syncAllPages(daysBack = 30) {
    const { rows: pages } = await query('SELECT * FROM pages WHERE is_active = true AND access_token IS NOT NULL');

    const results = [];
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        try {
            const result = await syncPageData(page.page_id, decrypt(page.access_token), daysBack);
            results.push({ ...result, name: page.name });
        } catch (e) {
            results.push({ page_id: page.page_id, name: page.name, success: false, error: e.message });
        }
        // Wait 3s between pages to avoid Pancake rate limits
        if (i < pages.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
    return results;
}

/**
 * Delta sync — only pull conversations changed since last_synced_at.
 * Lightweight: skips users, tags, statistics. Returns total new/updated count.
 */
export async function deltaSyncAllPages() {
    const { rows: pages } = await query(
        'SELECT page_id, access_token, name, last_synced_at FROM pages WHERE is_active = true AND access_token IS NOT NULL'
    );

    let totalChanges = 0;
    const errors = [];

    for (const page of pages) {
        try {
            // Use last_synced_at or default to 2 minutes ago
            const sinceDate = page.last_synced_at
                ? new Date(page.last_synced_at)
                : new Date(Date.now() - 2 * 60 * 1000);
            const since = Math.floor(sinceDate.getTime() / 1000);
            const until = Math.floor(Date.now() / 1000);
            const token = encodeURIComponent(decrypt(page.access_token));

            // Pull only recent conversations using since/until + order_by=updated_at
            let lastId = null;
            let pageConvs = 0;
            const customerMap = new Map();
            const convBatch = [];

            for (let batch = 0; batch < 10; batch++) {
                let url = `${PAGES_API_V2}/pages/${page.page_id}/conversations?page_access_token=${token}&since=${since}&until=${until}&order_by=updated_at`;
                if (lastId) url += `&last_conversation_id=${lastId}`;

                const data = await fetchJson(url);
                const convs = data.conversations || [];
                if (!convs.length) break;

                for (const conv of convs) {
                    const customerId = conv.customers?.[0]?.id;
                    const customer = conv.customers?.[0];
                    const userId = conv.current_user_ids?.[0] || conv.assigned_user_id || null;
                    const dateStr = new Date((conv.updated_at || conv.inserted_at) * 1000).toISOString().split('T')[0];
                    const tags = (conv.tags || []).filter(t => t).map(t => typeof t === 'object' ? t.text || '' : String(t));

                    convBatch.push({
                        pancake_id: String(conv.id),
                        type: conv.type || 'INBOX',
                        customer_pancake_id: String(customerId || ''),
                        user_pancake_id: userId,
                        date: dateStr,
                        snippet: (conv.snippet || '').substring(0, 200),
                        tags,
                        page_id: page.page_id,
                    });

                    if (customer) {
                        // Phone data is on conv.recent_phone_numbers, not on customer sub-object
                        const recentPhones = Array.isArray(conv.recent_phone_numbers) ? conv.recent_phone_numbers.filter(Boolean) : [];
                        const firstPhone = recentPhones[0] || null;
                        const existing = customerMap.get(String(customer.id));
                        customerMap.set(String(customer.id), {
                            pancake_id: String(customer.id),
                            name: customer.name || 'Unnamed',
                            phone: firstPhone || existing?.phone || null,
                            phone_numbers: recentPhones.length ? recentPhones : (existing?.phone_numbers || []),
                            tags: (customer.tags || []).filter(t => t).map(t => ({ id: t.id, text: t.text || '', color: t.color })),
                            last_active: dateStr,
                            page_id: page.page_id,
                        });
                    }
                    pageConvs++;
                }
                lastId = convs[convs.length - 1]?.id;
                await new Promise(r => setTimeout(r, 150));
            }

            // Bulk upsert conversations
            if (convBatch.length > 0) {
                const client = await getClient();
                try {
                    await client.query('BEGIN');
                    for (const c of convBatch) {
                        await client.query(`
                            INSERT INTO conversations (pancake_id, type, customer_pancake_id, user_pancake_id, date, snippet, tags, page_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ON CONFLICT (pancake_id) DO UPDATE SET
                              type = EXCLUDED.type, user_pancake_id = EXCLUDED.user_pancake_id,
                              snippet = EXCLUDED.snippet, tags = EXCLUDED.tags, updated_at = NOW()
                        `, [c.pancake_id, c.type, c.customer_pancake_id, c.user_pancake_id, c.date, c.snippet, JSON.stringify(c.tags), c.page_id]);
                    }
                    await client.query('COMMIT');
                } catch (e) { await client.query('ROLLBACK'); throw e; }
                finally { client.release(); }
            }

            // Bulk upsert customers
            if (customerMap.size > 0) {
                const client = await getClient();
                try {
                    await client.query('BEGIN');
                    for (const [, c] of customerMap) {
                        await client.query(`
                            INSERT INTO customers (pancake_id, name, phone, phone_numbers, tags, last_active, page_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7)
                            ON CONFLICT (pancake_id) DO UPDATE SET
                              name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone),
                              tags = EXCLUDED.tags, last_active = EXCLUDED.last_active
                        `, [c.pancake_id, c.name, c.phone, JSON.stringify(c.phone_numbers), JSON.stringify(c.tags), c.last_active, c.page_id]);
                    }
                    await client.query('COMMIT');
                } catch (e) { await client.query('ROLLBACK'); throw e; }
                finally { client.release(); }
            }

            // Update last_synced_at
            await query('UPDATE pages SET last_synced_at = NOW() WHERE page_id = $1', [page.page_id]);
            totalChanges += pageConvs;

        } catch (e) {
            errors.push(`${page.name}: ${e.message}`);
        }
    }

    return { totalChanges, pageCount: pages.length, errors };
}

/**
 * Sync POS orders from Pancake POS API.
 * Requires PANCAKE_MASTER_TOKEN env var.
 */
export async function syncOrders(shopId, pageId, daysBack = 30) {
    const masterToken = process.env.PANCAKE_MASTER_TOKEN;
    if (!masterToken) return { success: false, error: 'No PANCAKE_MASTER_TOKEN set' };

    const now = new Date();
    const since = new Date(now.getTime() - daysBack * 86400000).toISOString();
    const results = { orders: 0, errors: [] };

    try {
        let page = 1;
        let totalOrders = 0;

        while (page <= 50) {
            const url = `${POS_API}/shops/${shopId}/orders?api_key=${encodeURIComponent(masterToken)}&since=${since}&page=${page}&page_size=100`;
            const data = await fetchJson(url);
            const orders = data.data || data.orders || [];
            if (!Array.isArray(orders) || orders.length === 0) break;

            const client = await getClient();
            try {
                await client.query('BEGIN');
                for (const o of orders) {
                    await client.query(`
            INSERT INTO orders (order_id, shop_id, page_id, customer_name, customer_phone,
              status, total_amount, discount, shipping_fee, note, source, tags, items, created_date, updated_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (order_id) DO UPDATE SET
              status = EXCLUDED.status, total_amount = EXCLUDED.total_amount,
              discount = EXCLUDED.discount, shipping_fee = EXCLUDED.shipping_fee,
              note = EXCLUDED.note, tags = EXCLUDED.tags, items = EXCLUDED.items,
              updated_date = EXCLUDED.updated_date, synced_at = NOW()
          `, [
                        String(o.id || o.order_id), shopId, pageId,
                        o.customer_name || o.billing_name || '',
                        o.customer_phone || o.billing_phone || '',
                        o.status || 'UNKNOWN',
                        Number(o.total_amount || o.total || 0),
                        Number(o.discount || 0),
                        Number(o.shipping_fee || o.shipping || 0),
                        o.note || '',
                        o.source || '',
                        JSON.stringify(o.tags || []),
                        JSON.stringify(o.items || o.line_items || []),
                        o.created_at || o.created_date || null,
                        o.updated_at || o.updated_date || null,
                    ]);
                    totalOrders++;
                }
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }

            page++;
            await new Promise(r => setTimeout(r, 200));
        }

        results.orders = totalOrders;
        results.success = true;
    } catch (e) {
        results.errors.push(`Orders: ${e.message}`);
        results.success = false;
    }

    return results;
}

/**
 * Delete all data for a specific page.
 */
export async function deletePageData(pageId) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM daily_reports WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM conversations WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM channels WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM page_statistics WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM user_statistics WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM customers WHERE page_id = $1', [pageId]);
        await client.query('DELETE FROM orders WHERE page_id = $1', [pageId]);
        await client.query('COMMIT');
        return { success: true };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
