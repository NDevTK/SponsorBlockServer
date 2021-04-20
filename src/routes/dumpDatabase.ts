import {db} from '../databases/databases';
import {Logger} from '../utils/logger';
import {Request, Response} from 'express';
import { config } from '../config';
import util from 'util';
import fs from 'fs';
import path from 'path';
const unlink = util.promisify(fs.unlink);

const ONE_MINUTE = 1000 * 60;

const styleHeader = `<style>
    body {
        font-family: sans-serif
    }
    table th,
    table td {
        padding: 7px;
    }
    table th {
        text-align: left;
    }
    table tbody tr:nth-child(odd) {
        background: #efefef;
    }
</style>`

const licenseHeader = `<p>The API and database follow <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" rel="nofollow">CC BY-NC-SA 4.0</a> unless you have explicit permission.</p>
<p><a href="https://gist.github.com/ajayyy/4b27dfc66e33941a45aeaadccb51de71">Attribution Template</a></p>
<p>If you need to use the database or API in a way that violates this license, contact me with your reason and I may grant you access under a different license.</p></a></p>`;

const tables = config?.dumpDatabase?.tables ?? [];
const MILLISECONDS_BETWEEN_DUMPS = config?.dumpDatabase?.minTimeBetweenMs ?? ONE_MINUTE;
const appExportPath = config?.dumpDatabase?.appExportPath ?? './docker/database-export';
const postgresExportPath = config?.dumpDatabase?.postgresExportPath ?? '/opt/exports';
const tableNames = tables.map(table => table.name);

interface TableDumpList {
    fileName: string;
    tableName: string;
};
let latestDumpFiles: TableDumpList[] = [];

interface TableFile {
    file: string,
    timestamp: number
};

if (tables.length === 0) {
    Logger.warn('[dumpDatabase] No tables configured');
}

let lastUpdate = 0;
let updateQueued = false;

function removeOutdatedDumps(exportPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Get list of table names
        // Create array for each table
        const tableFiles: Record<string, TableFile[]> = tableNames.reduce((obj: any, tableName) => {
            obj[tableName] = [];
            return obj;
        }, {});

        // read files in export directory
        fs.readdir(exportPath, async (err: any, files: string[]) => {
            if (err) Logger.error(err);
            if (err) return resolve();

            files.forEach(file => {
                // we only care about files that start with "<tablename>_" and ends with .csv
                tableNames.forEach(tableName => {
                    if (file.startsWith(`${tableName}`) && file.endsWith('.csv')) {
                        const filePath = path.join(exportPath, file);
                        tableFiles[tableName].push({
                            file: filePath,
                            timestamp: fs.statSync(filePath).mtime.getTime()
                        });
                    }
                });
            });

            for (let tableName in tableFiles) {
                const files = tableFiles[tableName].sort((a, b) => b.timestamp - a.timestamp);
                for (let i = 2; i < files.length; i++) {
                    // remove old file
                    await unlink(files[i].file).catch((error: any) => {
                        Logger.error(`[dumpDatabase] Garbage collection failed ${error}`);
                    });
                }
            }

            resolve();
        });
    });
}

export default async function dumpDatabase(req: Request, res: Response, showPage: boolean) {
    if (!config?.dumpDatabase?.enabled) {
        res.status(404).send("Database dump is disabled");
        return;
    }
    if (!config.postgres) {
        res.status(404).send("Not supported on this instance");
        return;
    }

    const now = Date.now();
    updateQueued ||= now - lastUpdate > MILLISECONDS_BETWEEN_DUMPS;

    res.status(200)
    
    if (showPage) {
        res.send(`${styleHeader}
            <h1>SponsorBlock database dumps</h1>${licenseHeader}
            <h3>How this works</h3>
            Send a request to <code>https://sponsor.ajay.app/database.json</code>, or visit this page to trigger the database dump to run.
            Then, you can download the csv files below, or use the links returned from the JSON request.
            <h3>Links</h3>
            <table>
                <thead>
                    <tr>
                        <th>Table</th>
                        <th>CSV</th>
                    </tr>
                </thead>
                <tbody>
                ${latestDumpFiles.map((item:any) => {
                    return `
                    <tr>
                        <td>${item.tableName}</td>
                        <td><a href="/database/${item.tableName}">${item.tableName}</a></td>
                    </tr>
                    `;
                }).join('')}
                ${latestDumpFiles.length === 0 ? '<tr><td colspan="2">Please wait: Generating files</td></tr>' : ''}
                </tbody>
            </table>
            <hr/>
            ${updateQueued ? `Update queued.` : ``} Last updated: ${lastUpdate ? new Date(lastUpdate).toUTCString() : `Unknown`}`);
    } else {
        res.send({
            lastUpdated: lastUpdate,
            updateQueued,
            links: latestDumpFiles.map((item:any) => {
                return {
                    table: item.tableName,
                    url: `/database/${item.tableName}`,
                    size: item.fileSize,
                };
            }),
        })
    }

    if (updateQueued) {
        lastUpdate = Date.now();
        
        await removeOutdatedDumps(appExportPath);
        
        const dumpFiles = [];

        for (const table of tables) {
            const fileName = `${table.name}_${lastUpdate}.csv`;
            const file = `${postgresExportPath}/${fileName}`;
            await db.prepare('run', `COPY (SELECT * FROM "${table.name}"${table.order ? ` ORDER BY "${table.order}"` : ``}) 
                    TO '${file}' WITH (FORMAT CSV, HEADER true);`);
            dumpFiles.push({
                fileName,
                tableName: table.name,
            });
        }
        latestDumpFiles = [...dumpFiles];

        updateQueued = false;
    }
}

export async function redirectLink(req: Request, res: Response): Promise<void> {
    const file = latestDumpFiles.find((value) => "/database/" + value.tableName === req.path);

    if (file) {
        res.redirect("/download/" + file.fileName);
    } else {
        res.status(404).send();
    }
}