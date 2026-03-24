// Fetch real page names using master token
import 'dotenv/config';
import { query } from './db.js';

const MASTER_TOKEN = process.env.PANCAKE_MASTER_TOKEN;
if (!MASTER_TOKEN) { console.error('No PANCAKE_MASTER_TOKEN'); process.exit(1); }

async function main() {
    console.log('Using master token to fetch page list...');

    // Try the Pancake API with master token
    const url = `https://pages.fm/api/public_api/v1/pages?api_key=${encodeURIComponent(MASTER_TOKEN)}`;
    try {
        const res = await fetch(url);
        const text = await res.text();
        console.log('Response status:', res.status);
        console.log('Response (first 500 chars):', text.substring(0, 500));

        if (res.ok) {
            const data = JSON.parse(text);
            const pages = data.pages || data.data || (Array.isArray(data) ? data : []);
            console.log(`Found ${pages.length} pages`);
            for (const p of pages) {
                const id = String(p.id || p.page_id || '');
                const name = p.name || '';
                if (id && name) {
                    await query('UPDATE pages SET name = $1 WHERE page_id = $2', [name, id]);
                    console.log(`  ✅ ${id} → ${name}`);
                }
            }
        }
    } catch (e) {
        console.error('Master token API failed:', e.message);
    }

    // Alternative: try pages.fm conversations API to extract page names from conversation data
    console.log('\nAlternative: extracting names from stored conversation data...');
    // The page names might be in the v1 database backup. Let's check if there's a page_name field anywhere.
    try {
        const { rows } = await query(`
            SELECT DISTINCT page_id,
                   (SELECT name FROM users WHERE pancake_id = (
                       SELECT user_pancake_id FROM daily_reports WHERE page_id = pages.page_id LIMIT 1
                   )) as first_user_name
            FROM pages
            ORDER BY page_id
        `);
        console.log('Pages with user info:');
        for (const r of rows) console.log(`  ${r.page_id} → user: ${r.first_user_name || 'none'}`);
    } catch (e) {}

    // Show final state
    const { rows: final } = await query('SELECT page_id, name FROM pages ORDER BY name');
    console.log('\nFinal page names:');
    for (const p of final) console.log(`  ${p.page_id} → ${p.name}`);

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
