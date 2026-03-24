import { Router } from 'express';
import { syncPageData, syncAllPages, deletePageData } from '../services/pancakeSync.js';
import { query } from '../db.js';
import { clearCache } from '../index.js';
import { decrypt } from '../utils/crypto.js';

const router = Router();

// ── SSE Client Management ──────────────────
const sseClients = new Set();

export function broadcastSSE(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch { sseClients.delete(res); }
    }
}

/**
 * GET /api/sync/events — SSE endpoint for real-time updates
 */
router.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    sseClients.add(res);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    req.on('close', () => {
        sseClients.delete(res);
        clearInterval(heartbeat);
    });
});

/**
 * POST /api/sync/page — Sync a single page
 * Body: { page_id, access_token?, days_back? }
 */
router.post('/page', async (req, res) => {
    try {
        const { page_id, access_token, days_back = 30 } = req.body;
        if (!page_id) return res.status(400).json({ error: 'page_id required' });

        // If no token provided, look it up in DB (decrypt)
        let token = access_token;
        if (!token) {
            const { rows } = await query('SELECT access_token FROM pages WHERE page_id = $1', [page_id]);
            token = rows[0]?.access_token ? decrypt(rows[0].access_token) : null;
        }
        if (!token) return res.status(400).json({ error: 'No access token found' });

        const result = await syncPageData(page_id, token, days_back);
        clearCache('dash');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sync/all — Sync all active pages
 * Body: { days_back? }
 */
router.post('/all', async (req, res) => {
    try {
        const { days_back = 30 } = req.body;
        const results = await syncAllPages(days_back);
        clearCache('dash');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sync/delete — Delete all data for a page
 * Body: { page_id }
 */
router.post('/delete', async (req, res) => {
    try {
        const { page_id } = req.body;
        if (!page_id) return res.status(400).json({ error: 'page_id required' });
        const result = await deletePageData(page_id);
        clearCache('dash');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sync/validate-token — Validate a Pancake master API key
 * Body: { api_key }
 */
router.post('/validate-token', async (req, res) => {
    try {
        const { api_key } = req.body;
        if (!api_key) return res.status(400).json({ error: 'api_key required' });

        // Try Pages API first (session token / api_key)
        const pagesUrl = `https://pages.fm/api/public_api/v1/pages/106658275579351/tags?api_key=${encodeURIComponent(api_key)}`;
        const pagesResp = await fetch(pagesUrl);
        if (pagesResp.ok) {
            const data = await pagesResp.json();
            return res.json({ ok: true, status: pagesResp.status, type: 'pages_api', tags: data?.tags?.length || 0 });
        }

        // Fallback: try POS API
        const posUrl = `https://pos.pages.fm/api/v1/shops?api_key=${encodeURIComponent(api_key)}`;
        const posResp = await fetch(posUrl);
        if (posResp.ok) {
            const data = await posResp.json();
            return res.json({ ok: true, status: posResp.status, type: 'pos_api', shops: data?.data?.length || 0 });
        }

        res.json({ ok: false, status: pagesResp.status, pos_status: posResp.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sync/master-token — Save master token to server .env
 * Body: { token }
 */
router.post('/master-token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'token required' });
        // Update PANCAKE_MASTER_TOKEN in process.env (runtime)
        process.env.PANCAKE_MASTER_TOKEN = token;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/sync/status — Get sync status for all pages
 */
router.get('/status', async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT page_id, name, is_active, last_synced_at,
                   (SELECT COUNT(*) FROM daily_reports dr WHERE dr.page_id = p.page_id) AS report_count,
                   (SELECT COUNT(*) FROM conversations c WHERE c.page_id = p.page_id) AS conversation_count,
                   (SELECT COUNT(*) FROM customers cu WHERE cu.page_id = p.page_id) AS customer_count
            FROM pages p
            WHERE is_active = true
            ORDER BY name
        `);
        res.json({ pages: rows, server_time: new Date().toISOString(), hasToken: !!process.env.PANCAKE_MASTER_TOKEN });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/sync/page-name — Update a page's display name
 * Body: { pageId, name }
 */
router.post('/page-name', async (req, res) => {
    try {
        const { pageId, name } = req.body;
        if (!pageId || !name) return res.status(400).json({ error: 'pageId and name required' });
        await query('UPDATE pages SET name = $1 WHERE page_id = $2', [name.trim(), pageId]);
        clearCache();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH /api/sync/refresh-tags — Re-merge conversation tags into customer tags
 */
router.patch('/refresh-tags', async (req, res) => {
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
                      WHERE customer_pancake_id != '' AND jsonb_array_length(tags) > 0) sub
            ) agg
            WHERE c.pancake_id = agg.customer_pancake_id AND agg.merged_tags IS NOT NULL
        `);
        clearCache();
        res.json({ success: true, taggedCustomers: rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
