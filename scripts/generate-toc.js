'use strict';

/**
 * Generate toc.json from the parts book publication folder structure.
 *
 * Reads root index.json → per-publication index.json files → produces toc.json
 * that the API and upload script expect.
 *
 * Assemblies with subassemblies (direct_sheet_count === 0, subassembly_count > 0)
 * are represented as container groups with a `subassemblies` array instead of `sheets`.
 *
 * Usage:
 *   node scripts/generate-toc.js <source-dir> [--out=<path>]
 *
 * Example:
 *   node scripts/generate-toc.js "C:\Users\llal\..." --out="C:\Users\llal\...\toc.json"
 *
 * If --out is omitted, writes toc.json into <source-dir>/toc.json (overwrites existing).
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DATA_ROOT = args.find(a => !a.startsWith('--'));
const outArg = args.find(a => a.startsWith('--out='));
const OUT_PATH = outArg ? outArg.split('=').slice(1).join('=') : null;

if (!DATA_ROOT) {
    console.error('Usage: node scripts/generate-toc.js <source-dir> [--out=<path>]');
    process.exit(1);
}
if (!fs.existsSync(DATA_ROOT)) {
    console.error(`Source directory not found: ${DATA_ROOT}`);
    process.exit(1);
}

function readJson(absPath) {
    try {
        return JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch {
        return null;
    }
}

function mapSheets(rawSheets, pubDir) {
    return (rawSheets ?? []).map(sheet => ({
        slug: sheet.slug,
        label: sheet.title,
        sheet_number: sheet.sheet_number,
        assembly_image: sheet.assembly_image ? `${pubDir}/${sheet.assembly_image}` : undefined,
        table_image: sheet.table_image ? `${pubDir}/${sheet.table_image}` : undefined,
        parts_json: sheet.parts_json ? `${pubDir}/${sheet.parts_json}` : undefined,
    }));
}

function mapAssembly(asm, pubDir) {
    const slug = asm.directory
        ? asm.directory.split('/').pop()
        : (asm.slug ?? asm.directory ?? '');

    const base = {
        slug,
        label: asm.title,
        assembly_json: asm.assembly_json ? `${pubDir}/${asm.assembly_json}` : undefined,
        overview_image: asm.overview_image ? `${pubDir}/${asm.overview_image}` : undefined,
    };

    const rawSubs = asm.subassemblies ?? [];
    if (rawSubs.length > 0 && (asm.direct_sheet_count ?? 0) === 0) {
        return {
            ...base,
            sheets: [],
            subassemblies: rawSubs.map(sub => mapAssembly(sub, pubDir)),
        };
    }

    return {
        ...base,
        sheets: mapSheets(asm.sheets, pubDir),
    };
}

const rootIndex = readJson(path.join(DATA_ROOT, 'index.json'));
if (!rootIndex || !Array.isArray(rootIndex.pdfs)) {
    console.error('root index.json not found or missing "pdfs" array');
    process.exit(1);
}

console.log(`Found ${rootIndex.pdfs.length} publications in root index.json\n`);

const documents = [];
let totalSheets = 0;

for (const pub of rootIndex.pdfs) {
    const pubId = pub.publication_number;
    const pubDir = pub.directory;
    const pubIndexPath = path.join(DATA_ROOT, pubDir, 'index.json');
    const pubIndex = readJson(pubIndexPath);

    if (!pubIndex) {
        console.warn(`  [WARN] ${pubId}: missing ${pubDir}/index.json — skipping`);
        continue;
    }

    const assemblies = (pubIndex.assemblies ?? []).map(asm => mapAssembly(asm, pubDir));

    const sheetCount = pubIndex.sheet_count ?? 0;
    totalSheets += sheetCount;

    const subgroupCount = assemblies.filter(a => (a.subassemblies ?? []).length > 0).length;
    const subgroupNote = subgroupCount > 0 ? ` (${subgroupCount} with subgroups)` : '';
    console.log(`  ${pubId} — ${assemblies.length} groups${subgroupNote}, ${sheetCount} sheets`);

    documents.push({
        id: pubId,
        label: pubIndex.pdf_name ?? pubId,
        assemblies,
    });
}

const toc = { documents };
const outPath = OUT_PATH ?? path.join(DATA_ROOT, 'toc.json');
fs.writeFileSync(outPath, JSON.stringify(toc, null, 2), 'utf8');

console.log(`\nWrote toc.json → ${outPath}`);
console.log(`  Documents : ${documents.length}`);
console.log(`  Assemblies: ${documents.reduce((n, d) => n + d.assemblies.length, 0)}`);
console.log(`  Sheets    : ${totalSheets}`);
