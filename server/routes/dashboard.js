import { Router } from 'express';
import { query } from '../db.js';
import { getCached, setCache } from '../index.js';
import { decrypt } from '../utils/crypto.js';

const router = Router();

/**
 * GET /api/dashboard/kpis
 */
router.get('/kpis', async (req, res) => {
    try {
        const { from, to, pageId, prevFrom, prevTo } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });

        const cacheKey = `dash_kpis_${from}_${to}_${pageId || 'all'}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        const pageFilter = pageId ? 'AND page_id = $3' : '';
        const params = pageId ? [from, to, pageId] : [from, to];

        const sql = `
      SELECT
        COALESCE(SUM(conversations), 0) AS conversations,
        COALESCE(SUM(total_messages), 0) AS messages,
        COALESCE(SUM(unique_customers), 0) AS customers,
        COALESCE(SUM(has_phone), 0) AS phone,
        COALESCE(SUM(inbox_count), 0) AS inbox,
        COALESCE(SUM(comment_count), 0) AS comment,
        COALESCE(SUM(ads_linked), 0) AS "adsLinked",
        COALESCE(SUM(signed), 0) AS signed,
        COALESCE(SUM(wrong_target), 0) AS "wrongTarget",
        COUNT(*) AS "rowCount"
      FROM daily_reports
      WHERE date >= $1 AND date <= $2 ${pageFilter}
    `;
        const { rows: [current] } = await query(sql, params);

        // Parse tags_breakdown for additional signed detection
        const tagsSQL = `
      SELECT tags_breakdown FROM daily_reports
      WHERE date >= $1 AND date <= $2 ${pageFilter}
        AND tags_breakdown IS NOT NULL AND tags_breakdown != '{}'
    `;
        const { rows: tagRows } = await query(tagsSQL, params);
        let extraSigned = 0;
        for (const r of tagRows) {
            try {
                const tags = JSON.parse(r.tags_breakdown);
                for (const [tag, count] of Object.entries(tags)) {
                    const t = tag.toLowerCase();
                    if (['ký', 'kí', 'cọc', 'chốt'].some(k => t.includes(k))) {
                        extraSigned += Number(count) || 0;
                    }
                }
            } catch { /* ignore */ }
        }
        current.signed = Number(current.signed) + extraSigned;

        // Convert string numbers to actual numbers
        for (const key of Object.keys(current)) {
            current[key] = Number(current[key]);
        }

        // Previous period
        let prev = null;
        if (prevFrom && prevTo) {
            const prevParams = pageId ? [prevFrom, prevTo, pageId] : [prevFrom, prevTo];
            const { rows: [prevRow] } = await query(sql, prevParams);
            const { rows: prevTagRows } = await query(tagsSQL, prevParams);
            let prevExtraSigned = 0;
            for (const r of prevTagRows) {
                try {
                    const tags = JSON.parse(r.tags_breakdown);
                    for (const [tag, count] of Object.entries(tags)) {
                        const t = tag.toLowerCase();
                        if (['ký', 'kí', 'cọc', 'chốt'].some(k => t.includes(k))) {
                            prevExtraSigned += Number(count) || 0;
                        }
                    }
                } catch { /* ignore */ }
            }
            prevRow.signed = Number(prevRow.signed) + prevExtraSigned;
            for (const key of Object.keys(prevRow)) {
                prevRow[key] = Number(prevRow[key]);
            }
            prev = prevRow;
        }

        const result = { current, prev, rowCount: current.rowCount };
        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('KPI error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/trend
 */
router.get('/trend', async (req, res) => {
    try {
        const { from, to, pageId, groupBy = 'day' } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });

        const cacheKey = `dash_trend_${from}_${to}_${pageId || 'all'}_${groupBy}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        const pageFilter = pageId ? 'AND page_id = $3' : '';
        const params = pageId ? [from, to, pageId] : [from, to];

        let dateExpr, labelExpr;
        if (groupBy === 'month') {
            dateExpr = "TO_CHAR(date::date, 'YYYY-MM')";
            labelExpr = "TO_CHAR(date::date, 'MM/YYYY')";
        } else if (groupBy === 'week') {
            dateExpr = "TO_CHAR(date::date, 'IYYY-\"W\"IW')";
            labelExpr = "'Tuần ' || TO_CHAR(date::date, 'IW')";
        } else {
            dateExpr = 'date';
            labelExpr = "TO_CHAR(date::date, 'DD/MM')";
        }

        const sql = `
      SELECT
        ${dateExpr} AS key,
        ${labelExpr} AS label,
        COALESCE(SUM(conversations), 0)::int AS conversations,
        COALESCE(SUM(total_messages), 0)::int AS messages
      FROM daily_reports
      WHERE date >= $1 AND date <= $2 ${pageFilter}
      GROUP BY key, label
      ORDER BY key
      LIMIT 30
    `;

        const { rows } = await query(sql, params);
        setCache(cacheKey, rows);
        res.json(rows);
    } catch (err) {
        console.error('Trend error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/staff
 */
router.get('/staff', async (req, res) => {
    try {
        const { from, to, pageId } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });

        const cacheKey = `dash_staff_${from}_${to}_${pageId || 'all'}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        const pageFilter = pageId ? 'AND page_id = $3' : '';
        const params = pageId ? [from, to, pageId] : [from, to];

        const sql = `
      SELECT
        dr.user_pancake_id AS "userId",
        MAX(dr.user_name) AS "userName",
        SUM(dr.conversations)::int AS conversations,
        SUM(dr.total_messages)::int AS messages,
        SUM(dr.inbox_count)::int AS inbox,
        SUM(dr.comment_count)::int AS comment,
        SUM(dr.unique_customers)::int AS customers,
        SUM(dr.has_phone)::int AS phone,
        SUM(dr.wrong_target)::int AS "wrongTarget",
        SUM(dr.signed)::int AS signed,
        ARRAY_AGG(DISTINCT COALESCE(p.name, dr.page_id)) AS "pageNames"
      FROM daily_reports dr
      LEFT JOIN pages p ON p.page_id = dr.page_id
      WHERE dr.date >= $1 AND dr.date <= $2 ${pageFilter.replace(/page_id/g, 'dr.page_id')}
      GROUP BY dr.user_pancake_id
      HAVING SUM(dr.conversations) > 0
      ORDER BY SUM(dr.conversations) DESC
    `;

        const { rows: staff } = await query(sql, params);

        // Calculate totals
        const totals = staff.reduce((acc, s) => {
            acc.conversations += s.conversations;
            acc.messages += s.messages;
            acc.inbox += s.inbox;
            acc.comment += s.comment;
            acc.customers += s.customers;
            acc.phone += s.phone;
            acc.wrongTarget += s.wrongTarget;
            acc.signed += s.signed;
            return acc;
        }, { conversations: 0, messages: 0, inbox: 0, comment: 0, customers: 0, phone: 0, wrongTarget: 0, signed: 0 });

        const result = { staff, totals };
        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('Staff error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/daily
 */
router.get('/daily', async (req, res) => {
    try {
        const { from, to, pageId } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });

        const cacheKey = `dash_daily_${from}_${to}_${pageId || 'all'}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        const pageFilter = pageId ? 'AND page_id = $3' : '';
        const params = pageId ? [from, to, pageId] : [from, to];

        const sql = `
      SELECT
        dr.date,
        dr.user_pancake_id AS "userId",
        dr.user_name AS "userName",
        COALESCE(dr.page_id, '') AS "pageId",
        COALESCE(p.name, dr.page_id) AS "pageName",
        dr.conversations::int,
        dr.total_messages::int AS messages,
        dr.inbox_count::int AS inbox,
        dr.comment_count::int AS comment,
        dr.unique_customers::int AS customers,
        dr.wrong_target::int AS "wrongTarget",
        dr.signed::int,
        dr.other_tags::int AS "otherTags",
        COALESCE(dr.tags_breakdown, '{}') AS "tagsBreakdown"
      FROM daily_reports dr
      LEFT JOIN pages p ON p.page_id = dr.page_id
      WHERE dr.date >= $1 AND dr.date <= $2 ${pageFilter.replace(/page_id/g, 'dr.page_id')}
      ORDER BY dr.date DESC, dr.conversations DESC
    `;

        const { rows } = await query(sql, params);

        // Group by date
        const byDate = {};
        for (const r of rows) {
            if (!byDate[r.date]) {
                byDate[r.date] = {
                    users: [],
                    totals: { conversations: 0, messages: 0, inbox: 0, comment: 0, customers: 0, wrongTarget: 0, signed: 0, otherTags: 0 },
                };
            }
            byDate[r.date].users.push(r);
            const t = byDate[r.date].totals;
            t.conversations += r.conversations;
            t.messages += r.messages;
            t.inbox += r.inbox;
            t.comment += r.comment;
            t.customers += r.customers;
            t.wrongTarget += r.wrongTarget;
            t.signed += r.signed;
            t.otherTags += r.otherTags;
        }

        const result = Object.keys(byDate)
            .sort()
            .reverse()
            .map(date => ({ date, ...byDate[date] }));

        setCache(cacheKey, result);
        res.json(result);
    } catch (err) {
        console.error('Daily error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/customers
 * Server-side pagination, search, and lifecycle segmentation.
 * Query: ?pageId=x&search=x&page=1&limit=50&segment=active
 */
router.get('/customers', async (req, res) => {
    try {
        const { pageId, search, page = 1, limit = 50, segment, tag, tagFilter } = req.query;
        const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
        const lim = Math.min(200, Math.max(1, parseInt(limit)));

        let conditions = [];
        let params = [];
        let paramIdx = 1;

        if (pageId) {
            conditions.push(`page_id = $${paramIdx++}`);
            params.push(pageId);
        }
        if (search) {
            conditions.push(`(name ILIKE $${paramIdx} OR phone ILIKE $${paramIdx})`);
            params.push(`%${search}%`);
            paramIdx++;
        }

        // Server-side tag filters
        if (tagFilter === '__NEW_TODAY__') {
            conditions.push(`(tags IS NULL OR tags = '[]'::jsonb)`);
            conditions.push(`last_active >= (CURRENT_DATE - 30)::text`);
        } else if (tagFilter === '__HAS_PHONE__') {
            conditions.push(`(
                (phone IS NOT NULL AND phone != '') OR 
                (phone_numbers IS NOT NULL AND phone_numbers != '[]'::jsonb AND phone_numbers != 'null'::jsonb) OR 
                tags::text ILIKE '%SĐT%'
            )`);
        } else if (tag) {
            // Comma-separated tags, OR logic, case-insensitive
            const tagList = tag.split(',').filter(Boolean);
            if (tagList.length) {
                const tagConditions = tagList.map(t => {
                    params.push(`%${t.trim()}%`);
                    return `tags::text ILIKE $${paramIdx++}`;
                });
                conditions.push(`(${tagConditions.join(' OR ')})`);
            }
        }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Total count
        const { rows: [{ count: total }] } = await query(
            `SELECT COUNT(*) AS count FROM customers ${where}`, params
        );

        // Paginated data
        const sql = `
      SELECT pancake_id, name, phone, phone_numbers, gender, tags,
             last_active, page_id, total_conversations,
             CASE
               WHEN total_conversations <= 1 AND last_active >= (CURRENT_DATE - 30)::text THEN 'new'
               WHEN total_conversations BETWEEN 2 AND 5 AND last_active >= (CURRENT_DATE - 30)::text THEN 'active'
               WHEN total_conversations > 5 AND last_active >= (CURRENT_DATE - 30)::text THEN 'loyal'
               WHEN last_active < (CURRENT_DATE - 30)::text AND last_active >= (CURRENT_DATE - 90)::text THEN 'at_risk'
               WHEN last_active < (CURRENT_DATE - 90)::text THEN 'churned'
               ELSE 'new'
             END AS segment
      FROM customers
      ${where}
      ORDER BY last_active DESC NULLS LAST
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
        params.push(lim, offset);

        const { rows } = await query(sql, params);

        // Parse JSONB fields
        const result = rows.map(r => ({
            ...r,
            phone_numbers: typeof r.phone_numbers === 'string' ? JSON.parse(r.phone_numbers) : (r.phone_numbers || []),
            tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
            id: r.pancake_id,
            psid: r.pancake_id,
        }));

        // Segment counts
        const { rows: segCounts } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE total_conversations <= 1 AND last_active >= (CURRENT_DATE - 30)::text) AS new,
        COUNT(*) FILTER (WHERE total_conversations BETWEEN 2 AND 5 AND last_active >= (CURRENT_DATE - 30)::text) AS active,
        COUNT(*) FILTER (WHERE total_conversations > 5 AND last_active >= (CURRENT_DATE - 30)::text) AS loyal,
        COUNT(*) FILTER (WHERE last_active < (CURRENT_DATE - 30)::text AND last_active >= (CURRENT_DATE - 90)::text) AS at_risk,
        COUNT(*) FILTER (WHERE last_active < (CURRENT_DATE - 90)::text) AS churned
      FROM customers ${where}
    `, params.slice(0, params.length - 2));

        res.json({
            data: result,
            pagination: {
                page: parseInt(page),
                limit: lim,
                total: parseInt(total),
                totalPages: Math.ceil(parseInt(total) / lim),
            },
            segments: segCounts[0] || {},
        });
    } catch (err) {
        console.error('Customers error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/tag-categories — All tag classifications
 */
router.get('/tag-categories', async (req, res) => {
    try {
        const { rows } = await query('SELECT tag_name, category, display_name, color FROM tag_classifications ORDER BY category, sort_order');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/branch-summary — Tổng hợp theo chi nhánh (tag-based)
 */
router.get('/branch-summary', async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });

        const cacheKey = `dash_branch_${from}_${to}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        // Get branch tags
        const { rows: branchTags } = await query(
            `SELECT tag_name, display_name, color FROM tag_classifications WHERE category = 'branch' AND is_active = TRUE ORDER BY sort_order`
        );

        // Get all customers with their tags
        const branches = [];
        for (const bt of branchTags) {
            const { rows: [counts] } = await query(`
                SELECT
                    COUNT(*) AS total_customers,
                    COUNT(*) FILTER(WHERE
                        (phone IS NOT NULL AND phone != '') OR
                        (phone_numbers IS NOT NULL AND phone_numbers != '[]'::jsonb AND phone_numbers != 'null'::jsonb)
                    ) AS has_phone,
                    COUNT(*) FILTER(WHERE tags::text ~* 'KÝ|KÍ|CHỐT') AS signed,
                    COUNT(*) FILTER(WHERE tags::text ILIKE '%TIỀM NĂNG%') AS potential,
                    COUNT(*) FILTER(WHERE tags::text ILIKE '%HẸN ĐẾN%' OR tags::text ILIKE '%ĐÃ ĐẾN%') AS visiting,
                    COUNT(*) FILTER(WHERE tags::text ILIKE '%MẤT%') AS lost
                FROM customers
                WHERE tags::text ILIKE $1
            `, [`%${bt.tag_name}%`]);

            branches.push({
                tag_name: bt.tag_name,
                display_name: bt.display_name,
                color: bt.color,
                total_customers: parseInt(counts.total_customers),
                has_phone: parseInt(counts.has_phone),
                signed: parseInt(counts.signed),
                potential: parseInt(counts.potential),
                visiting: parseInt(counts.visiting),
                lost: parseInt(counts.lost),
                close_rate: parseInt(counts.total_customers) > 0
                    ? (parseInt(counts.signed) / parseInt(counts.total_customers) * 100).toFixed(1)
                    : '0',
            });
        }

        setCache(cacheKey, branches, 120_000);
        res.json(branches);
    } catch (err) {
        console.error('Branch summary error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/tag-counts
 * Count customers per tag by scanning jsonb tags array.
 */
router.get('/tag-counts', async (req, res) => {
    try {
        const cached = getCached('tag_counts');
        if (cached) return res.json(cached);

        const { rows } = await query(`
            SELECT tag_value, COUNT(DISTINCT c.pancake_id) AS customer_count
            FROM customers c,
                 jsonb_array_elements_text(c.tags) AS tag_value
            WHERE c.tags IS NOT NULL AND jsonb_array_length(c.tags) > 0
            GROUP BY tag_value
            ORDER BY customer_count DESC
        `);
        const result = {};
        for (const r of rows) {
            result[r.tag_value.toLowerCase()] = parseInt(r.customer_count);
        }
        setCache('tag_counts', result, 120_000);
        res.json(result);
    } catch (err) {
        console.error('Tag counts error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/customer/:id/conversations
 * Return conversation history for a specific customer.
 */
router.get('/customer/:id/conversations', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 50 } = req.query;
        const sql = `
          SELECT c.pancake_id, c.type, c.date, c.snippet, c.tags,
                 c.user_pancake_id, u.name AS user_name, c.page_id, c.messages_synced
          FROM conversations c
          LEFT JOIN users u ON u.pancake_id = c.user_pancake_id
          WHERE c.customer_pancake_id = $1
          ORDER BY c.date DESC, c.created_at DESC
          LIMIT $2
        `;
        const { rows } = await query(sql, [id, parseInt(limit)]);
        const result = rows.map(r => ({
            ...r,
            tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
        }));
        res.json(result);
    } catch (err) {
        console.error('Customer conversations error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/customer/:id/messages
 * Return all messages across all conversations for a customer.
 * On first request per conversation, fetches from Pancake API and caches in messages table.
 */
router.get('/customer/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 100 } = req.query;

        // 1. Find all conversations for this customer
        const { rows: convs } = await query(
            'SELECT pancake_id, page_id, messages_synced FROM conversations WHERE customer_pancake_id = $1',
            [id]
        );

        // 2. For any un-synced conversations, fetch messages from Pancake API
        const unsynced = convs.filter(c => !c.messages_synced);
        if (unsynced.length > 0) {
            // Get page access tokens
            const pageIds = [...new Set(unsynced.map(c => c.page_id).filter(Boolean))];
            const tokenMap = {};
            for (const pid of pageIds) {
                const { rows: [page] } = await query('SELECT access_token FROM pages WHERE page_id = $1', [pid]);
                if (page?.access_token) tokenMap[pid] = decrypt(page.access_token);
            }

            // Fetch messages from Pancake for each un-synced conversation
            for (const conv of unsynced.slice(0, 10)) { // Limit to 10 per request
                const token = tokenMap[conv.page_id];
                if (!token) continue;

                try {
                    const url = `https://pages.fm/api/public_api/v1/pages/${conv.page_id}/conversations/${conv.pancake_id}/messages?page_access_token=${encodeURIComponent(token)}`;
                    const response = await fetch(url);
                    if (!response.ok) continue;
                    const data = await response.json();
                    const msgs = data.messages || data.data || [];

                    if (Array.isArray(msgs) && msgs.length > 0) {
                        for (const m of msgs) {
                            const msgId = String(m.id || m.mid || `${conv.pancake_id}_${m.created_time || Date.now()}`);
                            const senderType = m.from?.id === conv.page_id ? 'page' : 'customer';
                            const content = m.message || m.text || '';
                            const attachments = m.attachments || [];

                            await query(`
                                INSERT INTO messages (pancake_id, conversation_pancake_id, page_id, sender_type, sender_id, sender_name, content, attachments, message_type, created_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(TO_TIMESTAMP($10::bigint), NOW()))
                                ON CONFLICT (pancake_id) DO NOTHING
                            `, [
                                msgId, conv.pancake_id, conv.page_id, senderType,
                                m.from?.id || '', m.from?.name || '',
                                content, JSON.stringify(attachments),
                                attachments.length > 0 ? 'attachment' : 'text',
                                m.created_time || null
                            ]);
                        }
                    }

                    // Mark conversation as synced
                    await query('UPDATE conversations SET messages_synced = TRUE WHERE pancake_id = $1', [conv.pancake_id]);
                } catch (e) {
                    console.warn(`Message sync failed for conv ${conv.pancake_id}:`, e.message);
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // 3. Return all messages from DB
        const { rows: messages } = await query(`
            SELECT m.pancake_id, m.conversation_pancake_id, m.sender_type, m.sender_name,
                   m.content, m.attachments, m.message_type, m.created_at
            FROM messages m
            WHERE m.conversation_pancake_id IN (
                SELECT pancake_id FROM conversations WHERE customer_pancake_id = $1
            )
            ORDER BY m.created_at ASC
            LIMIT $2
        `, [id, parseInt(limit)]);

        res.json(messages);
    } catch (err) {
        console.error('Customer messages error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/dashboard/customer-kpis — Accurate counts from full DB
 */
router.get('/customer-kpis', async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT
              COUNT(*) FILTER(WHERE (tags IS NULL OR tags = '[]'::jsonb) AND last_active >= (CURRENT_DATE - 30)::text) AS new_count,
              COUNT(*) FILTER(WHERE
                (phone IS NOT NULL AND phone != '') OR
                (phone_numbers IS NOT NULL AND phone_numbers != '[]'::jsonb AND phone_numbers != 'null'::jsonb) OR
                tags::text ILIKE '%SĐT%'
              ) AS has_phone,
              COUNT(*) FILTER(WHERE
                tags::text ~* 'CHỤP|thuê váy|Phim trường|studio|Ngày Cưới|couple'
              ) AS interested,
              COUNT(*) FILTER(WHERE
                tags::text ~* 'KÝ|KÍ|CHỐT'
              ) AS signed
            FROM customers
        `);
        res.json(rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
