/**
 * Capture les écrans de l'app avec le jeu de démo, pour les relire à l'œil.
 * Vérifie aussi qu'aucune erreur console n'est émise.
 *
 *   node scripts/screenshot.mjs [url] [fichier-json]
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4300';
const DATA = process.argv[3] ?? '/tmp/demo-gitstats.json';
const OUT = '/tmp/gitstats-shots';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  // Surchargeable : `CHROME_PATH=/usr/bin/chromium node scripts/screenshot.mjs`
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    problems.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto(`${URL_BASE}/#/connexion`, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 20_000 });

// Import du jeu de démo par le vrai chemin de l'application.
await page.setInputFiles('input[type=file]', DATA);
await page.waitForSelector('text=Commits', { timeout: 20_000 });
await page.waitForTimeout(2500);

const shots = [
  ['01-global', '/#/'],
  ['02-projets', '/#/projets'],
  ['03-personnes', '/#/personnes'],
  ['04-comparer', '/#/comparer'],
  ['05-reglages', '/#/reglages'],
];

for (const [name, path] of shots) {
  await page.goto(`${URL_BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${name} ✓`);
}

// Détail d'un dépôt et d'une personne.
await page.goto(`${URL_BASE}/#/projets`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('[role=row]').nth(1).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/06-projet-detail.png`, fullPage: true });
console.log('06-projet-detail ✓');

await page.goto(`${URL_BASE}/#/personnes`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('[role=row]').nth(1).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/07-personne-detail.png`, fullPage: true });
console.log('07-personne-detail ✓');

console.log(problems.length === 0 ? '\nAucune erreur console.' : `\n${problems.length} problème(s) console :`);
for (const problem of [...new Set(problems)].slice(0, 20)) console.log('  ' + problem);

await browser.close();
