/**
 * Régénère les captures d'écran publiées dans le README, à partir du jeu de démo.
 *
 * Séparé de `screenshot.mjs`, qui sert au contrôle visuel de tous les écrans :
 * ici on ne garde que les vues montrables, cadrées pour la lecture sur GitHub
 * (les tableaux sont virtualisés — une capture pleine page ajouterait une bande
 * vide sous les lignes rendues).
 *
 *   npm run demo:data && npm run dev
 *   node scripts/readme-shots.mjs [url] [fichier-json]
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4300';
const DATA = process.argv[3] ?? 'demo-gitstats.json';
const OUT = 'docs/screenshots';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    problems.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto(`${URL_BASE}/#/connexion`, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 20_000 });

// L'écran d'accueil se capture avant l'import : une fois les données chargées,
// il redirige vers le tableau de bord. Il est étroit — le cadrer large le
// noierait dans ses marges.
await page.setViewportSize({ width: 900, height: 1000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/connexion.png`, fullPage: true });
console.log('connexion ✓');
await page.setViewportSize({ width: 1500, height: 1000 });

await page.setInputFiles('input[type=file]', DATA);
await page.waitForSelector('text=Commits', { timeout: 20_000 });
await page.waitForTimeout(2500);

const go = async (path) => {
  await page.goto(`${URL_BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
};

/** Une capture pleine page : écrans composés de cartes, sans zone virtualisée. */
const full = async (name, path) => {
  await go(path);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${name} ✓`);
};

/**
 * Une capture rognée sous la dernière carte : écrans dominés par un tableau
 * virtualisé, dont la hauteur est bornée par la fenêtre et laisse sinon une
 * bande vide en bas de l'image.
 */
const viewport = async (name, path) => {
  await go(path);
  const bottom = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('section')];
    const last = sections.at(-1);
    return last ? Math.ceil(last.getBoundingClientRect().bottom) : window.innerHeight;
  });
  const { width, height } = page.viewportSize();
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: 0, y: 0, width, height: Math.min(bottom + 16, height) },
  });
  console.log(`${name} ✓`);
};

/** Une carte isolée, quand seule une section de l'écran mérite d'être montrée. */
const card = async (name, path, title) => {
  await go(path);
  const section = page.locator('section').filter({ hasText: title }).first();
  await section.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name} ✓`);
};

await full('global', '/#/');
await viewport('projets', '/#/projets');
await viewport('personnes', '/#/personnes');
await full('comparer', '/#/comparer');

// Le détail s'atteint par un clic sur une ligne : c'est le seul chemin, la clé
// de projet n'est pas devinable depuis l'extérieur.
await go('/#/projets');
await page.locator('[role=row]').nth(1).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/projet-detail.png`, fullPage: true });
console.log('projet-detail ✓');

await go('/#/personnes');
await page.locator('[role=row]').nth(1).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/personne-detail.png`, fullPage: true });
console.log('personne-detail ✓');

await card('identites', '/#/reglages', 'Identités des contributeurs');
await card('doublons', '/#/reglages', 'Dépôts en double entre instances');

console.log(problems.length === 0 ? '\nAucune erreur console.' : `\n${problems.length} problème(s) console :`);
for (const problem of [...new Set(problems)].slice(0, 20)) console.log('  ' + problem);

await browser.close();
