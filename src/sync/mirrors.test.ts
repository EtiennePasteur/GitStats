import { describe, it, expect } from 'vitest';
import { detectMirrors, suggestExclusions } from './mirrors';
import type { ProjectKey, StoredProject } from '../model/types';

function project(key: ProjectKey, name: string): StoredProject {
  const [instanceId, id] = key.split('~');
  return {
    key,
    gitlabId: Number(id),
    instanceId: instanceId!,
    name,
    nameWithNamespace: name,
    pathWithNamespace: `g/${name}`,
    namespaceFullPath: 'g',
    defaultBranch: 'main',
    webUrl: '',
    avatarUrl: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    archived: false,
    lastActivityAt: '2026-08-17T00:00:00.000Z',
    sync: {
      state: 'done',
      coveredFrom: null,
      coveredUntil: null,
      syncedActivityAt: null,
      lastSyncedAt: null,
      commitCount: 0,
      recentShas: [],
      hasOverview: true,
      error: null,
      currentPage: 0,
      fingerprint: 'x',
    },
  };
}

describe('detectMirrors', () => {
  it('repère deux dépôts partageant des commits sur des instances différentes', () => {
    const projects = [project('inst-a~1', 'api'), project('inst-b~7', 'api-mirror')];
    const groups = detectMirrors(
      projects,
      new Map([
        ['inst-a~1', ['sha1', 'sha2', 'sha3']],
        ['inst-b~7', ['sha1', 'sha2', 'sha9']],
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectKeys).toEqual(['inst-a~1', 'inst-b~7']);
    expect(groups[0]!.sharedShaCount).toBe(2);
    expect(groups[0]!.instanceIds).toEqual(['inst-a', 'inst-b']);
  });

  it('IGNORE deux dépôts d\'une même instance', () => {
    // Un fork interne est un projet légitime que l'utilisateur suit sciemment,
    // pas un doublon à écarter.
    const projects = [project('inst-a~1', 'api'), project('inst-a~2', 'api-fork')];
    const groups = detectMirrors(
      projects,
      new Map([
        ['inst-a~1', ['sha1', 'sha2']],
        ['inst-a~2', ['sha1', 'sha2']],
      ]),
    );
    expect(groups).toEqual([]);
  });

  it('ne rapproche pas des dépôts sans commit commun', () => {
    const projects = [project('inst-a~1', 'api'), project('inst-b~1', 'autre')];
    const groups = detectMirrors(
      projects,
      new Map([
        ['inst-a~1', ['sha1', 'sha2']],
        ['inst-b~1', ['sha8', 'sha9']],
      ]),
    );
    expect(groups).toEqual([]);
  });

  it('regroupe transitivement un miroir en cascade', () => {
    // A ↔ B et B ↔ C doivent donner UN groupe de trois, pas deux paires.
    const projects = [project('inst-a~1', 'api'), project('inst-b~1', 'api'), project('inst-c~1', 'api')];
    const groups = detectMirrors(
      projects,
      new Map([
        ['inst-a~1', ['s1', 's2']],
        ['inst-b~1', ['s2', 's3']],
        ['inst-c~1', ['s3', 's4']],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectKeys).toEqual(['inst-a~1', 'inst-b~1', 'inst-c~1']);
  });

  it('ignore les dépôts inconnus du parc', () => {
    const groups = detectMirrors(
      [project('inst-a~1', 'api')],
      new Map([
        ['inst-a~1', ['sha1']],
        ['inst-z~9', ['sha1']], // absent de la liste des projets
      ]),
    );
    expect(groups).toEqual([]);
  });

  it('classe les groupes par nombre de commits partagés', () => {
    const projects = [
      project('inst-a~1', 'a1'),
      project('inst-b~1', 'b1'),
      project('inst-a~2', 'a2'),
      project('inst-b~2', 'b2'),
    ];
    const groups = detectMirrors(
      projects,
      new Map([
        ['inst-a~1', ['x1']],
        ['inst-b~1', ['x1']],
        ['inst-a~2', ['y1', 'y2', 'y3']],
        ['inst-b~2', ['y1', 'y2', 'y3']],
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.sharedShaCount).toBe(3);
    expect(groups[1]!.sharedShaCount).toBe(1);
  });

  it('tient sur un parc réaliste sans comparaison quadratique', () => {
    const projects: StoredProject[] = [];
    const shas = new Map<ProjectKey, string[]>();
    for (let i = 1; i <= 234; i++) {
      projects.push(project(`inst-a~${i}`, `p${i}`));
      shas.set(`inst-a~${i}`, Array.from({ length: 100 }, (_, k) => `a-${i}-${k}`));
    }
    // Une seule vraie paire mirrorée, noyée dans le parc.
    projects.push(project('inst-b~1', 'miroir'));
    shas.set('inst-b~1', shas.get('inst-a~5')!.slice(0, 50));

    const started = performance.now();
    const groups = detectMirrors(projects, shas);
    const elapsed = performance.now() - started;

    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectKeys).toEqual(['inst-a~5', 'inst-b~1']);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('suggestExclusions', () => {
  it('conserve le dépôt le plus fourni et écarte les autres', () => {
    const groups = detectMirrors(
      [project('inst-a~1', 'api'), project('inst-b~7', 'miroir')],
      new Map([
        ['inst-a~1', ['s1', 's2']],
        ['inst-b~7', ['s1', 's2']],
      ]),
    );
    const excluded = suggestExclusions(
      groups,
      new Map([
        ['inst-a~1', 900],
        ['inst-b~7', 120],
      ]),
    );
    // Le miroir partiel est écarté, l'original conservé.
    expect(excluded).toEqual(['inst-b~7']);
  });

  it('reste déterministe à volume égal', () => {
    const groups = detectMirrors(
      [project('inst-a~1', 'api'), project('inst-b~1', 'api')],
      new Map([
        ['inst-a~1', ['s1']],
        ['inst-b~1', ['s1']],
      ]),
    );
    const counts = new Map([
      ['inst-a~1', 100],
      ['inst-b~1', 100],
    ]);
    expect(suggestExclusions(groups, counts)).toEqual(suggestExclusions(groups, counts));
  });
});
